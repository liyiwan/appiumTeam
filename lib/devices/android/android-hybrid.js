"use strict";

var logger = require('../../server/logger.js').get('appium')
  , _ = require('underscore')
  , errors = require('../../server/errors.js')
  , path = require('path')
  , system = require('appium-support').system
  , isWindows = system.isWindows()
  , isLinux = system.isLinux()
  , exec = require('child_process').exec
  , UnknownError = errors.UnknownError
  , async = require('async')
  , Chromedriver = require('appium-chromedriver').default
  , status = require("../../server/status.js");

var androidHybrid = {};

androidHybrid.chromedriver = null;
androidHybrid.sessionChromedrivers = {};

androidHybrid.listWebviews = function (cb) {
  logger.debug("Getting a list of available webviews");
  var webviews = [];
  var definedDeviceSocket = this.args.androidDeviceSocket;
  this.adb.shell("cat /proc/net/unix", function (err, out) {
    if (err) return cb(err);
    _.each(out.split("\n"), function (line) {
      line = line.trim();
      var webviewPid = line.match(/@?webview_devtools_remote_(\d+)/);
      if (definedDeviceSocket) {
        if (line.indexOf("@" + definedDeviceSocket) ===
          line.length - definedDeviceSocket.length - 1) {
          if (webviewPid) {
            webviews.push(this.WEBVIEW_BASE + webviewPid[1]);
          } else {
            webviews.push(this.CHROMIUM_WIN);
          }
        }
      } else if (webviewPid) {
        // for multiple webviews a list of 'WEBVIEW_<index>' will be returned
        // where <index> is zero based (same is in selendroid)
        webviews.push(this.WEBVIEW_BASE + webviewPid[1]);
      }
    }.bind(this));
    webviews = _.uniq(webviews);

    if (definedDeviceSocket) {
      return cb(null, webviews);
    }

    var webviewsTmp = webviews;
    webviews = [];

    var getProcessNameFromWebview = function (view, cb) {
      this.getProcessNameFromWebview(view, function (err, pkg) {
        if (err) return cb(err);
        webviews.push(this.WEBVIEW_BASE + pkg);
        cb();
      }.bind(this));
    }.bind(this);

    async.each(webviewsTmp, getProcessNameFromWebview, function (err) {
      if (err) return cb(err);
      logger.debug("Available contexts: " + this.contexts);
      logger.debug(JSON.stringify(webviews));
      cb(null, webviews);
    }.bind(this));
  }.bind(this));
};

var previousState = {};

// remember whether we were previously proxying to a chromedriver or not
androidHybrid.rememberProxyState = function () {
  previousState.isProxy = this.isProxy;
};

androidHybrid.restoreProxyState = function () {
  this.isProxy = previousState.isProxy;
};

androidHybrid.getProcessNameFromWebview = function (webview, cb) {
  // webview_devtools_remote_4296 => 4296
  var pid = webview.match(/\d+$/);
  if (!pid) return cb("No pid for webview " + webview);
  pid = pid[0];
  logger.debug(webview + " mapped to pid " + pid);

  logger.debug("Getting process name for webview");
  this.adb.shell("ps", function (err, out) {
    if (err) return cb(err);
    var pkg = "unknown";

    var lines = out.split(/\r?\n/);
    /*
     USER     PID   PPID  VSIZE  RSS     WCHAN    PC         NAME
     u0_a136   6248  179   946000 48144 ffffffff 4005903e R com.example.test
     */
    var header = lines[0].trim().split(/\s+/);
    // the column order may not be identical on all androids
    // dynamically locate the pid and name column.
    var pidColumn = header.indexOf("PID");
    var pkgColumn = header.indexOf("NAME") + 1;

    _.find(lines, function (line) {
      line = line.trim().split(/\s+/);
      if (line[pidColumn].indexOf(pid) !== -1) {
        logger.debug("Parsed pid: " + line[pidColumn] + " pkg: " + line[pkgColumn]);
        logger.debug("from: " + line);
        pkg = line[pkgColumn];
        return pkg; // exit from _.find
      }
    });

    logger.debug("returning process name: " + pkg);
    cb(null, pkg);
  });
};

androidHybrid.startChromedriverProxy = function (context, cb) {
  cb = _.once(cb);
  logger.debug("Connecting to chrome-backed webview");
  if (this.chromedriver !== null) {
    return cb(new Error("We already have a chromedriver instance running"));
  }

  if (this.sessionChromedrivers[context]) {
    // in the case where we've already set up a chromedriver for a context,
    // we want to reconnect to it, not create a whole new one
    this.setupExistingChromedriver(context, cb);
  } else {
    this.setupNewChromedriver(context, cb);
  }
};

androidHybrid.setupNewChromedriver = function (context, cb) {
  var chromeArgs = {
    port: this.args.chromeDriverPort,
    executable: this.args.chromedriverExecutable
  };
  this.chromedriver = new Chromedriver(chromeArgs);
  this.proxyReqRes = this.chromedriver.proxyReq.bind(this.chromedriver);
  this.rememberProxyState();
  this.isProxy = true;
  var caps = {
    chromeOptions: {
      androidPackage: this.args.appPackage,
      androidUseRunningApp: true
    }
  };
  if (this.args.enablePerformanceLogging) {
    caps.loggingPrefs = {performance: 'ALL'};
  }
  // For now the only known arg passed this way is androidDeviceSocket used
  // by Operadriver (deriving from Chromedriver) // We don't know how other
  // Chromium embedders will call this argument so for now it's name needs to
  // be configurable. When Google adds the androidDeviceSocket argument to
  // the original Chromedriver then we will be sure about its name for all
  // Chromium embedders (as their Webdrivers will derive from Chromedriver)
  if (this.args.specialChromedriverSessionArgs) {
    _.each(this.args.specialChromedriverSessionArgs, function (val, option) {
      logger.debug("This method is being deprecated. Apply chromeOptions " +
                   "normally to pass along options,see sites.google.com/a/" +
                   "chromium.org/chromedriver/capabilities for more info");
      caps.chromeOptions[option] = val;
    });
  }
  caps = this.decorateChromeOptions(caps);
  this.chromedriver.on(Chromedriver.EVENT_CHANGED, function (msg) {
    if (msg.state === Chromedriver.STATE_STOPPED) {
      // bind our stop/exit handler, passing in context so we know which
      // one stopped unexpectedly
      this.onChromedriverStop(context);
    }
  }.bind(this));
  this.chromedriver.start(caps).nodeify(function (err) {
    if (err) return cb(err);
    // save the chromedriver object under the context
    this.sessionChromedrivers[context] = this.chromedriver;
    cb();
  }.bind(this));
};


androidHybrid.setupExistingChromedriver = function (context, cb) {
  logger.debug("Found existing Chromedriver for context '" + context + "'." +
               " Using it.");
  this.rememberProxyState();
  this.chromedriver = this.sessionChromedrivers[context];
  this.proxyReqRes = this.chromedriver.proxyReq.bind(this.chromedriver);
  this.isProxy = true;

  // check the status by sending a simple window-based command to ChromeDriver
  // if there is an error, we want to recreate the ChromeDriver session
  this.chromedriver.hasWorkingWebview().nodeify(function (err, works) {
    if (err) return cb(err);
    if (works) return cb();
    logger.debug("ChromeDriver is not associated with a window. " +
                 "Re-initializing the session.");
    this.chromedriverRestartingContext = context;
    this.chromedriver.restart().nodeify(function (err) {
      if (err) return cb(err);
      this.chromedriverRestartingContext = null;
      cb();
    }.bind(this));
  }.bind(this));
};

androidHybrid.onChromedriverStop = function (context) {
  logger.warn("Chromedriver for context " + context + " stopped unexpectedly");
  if (context === this.curContext) {
    // if we don't have a stop callback, we exited unexpectedly and so want
    // to shut down the session and respond with an error
    // TODO: this kind of thing should be emitted and handled by a higher-level
    // controlling function
    var error = new UnknownError("Chromedriver quit unexpectedly during session");
    logger.error(error.message);
    if (typeof this.cbForCurrentCmd === "function") {
      this.shutdown(function () {
        this.cbForCurrentCmd(error, null);
      }.bind(this));
    }
  } else if (context !== this.chromedriverRestartingContext) {
    // if a Chromedriver in the non-active context barfs, we don't really
    // care, we'll just make a new one next time we need the context.
    // The only time we ignore this is if we know we're in the middle of a
    // Chromedriver restart
    logger.warn("Chromedriver quit unexpectedly, but it wasn't the active " +
                "context, ignoring");
    delete this.sessionChromedrivers[context];
  }
};

androidHybrid.suspendChromedriverProxy = function (cb) {
  this.chromedriver = null;
  this.restoreProxyState();
  cb();
};

androidHybrid.stopChromedriverProxies = function (ocb) {
  async.eachSeries(Object.keys(this.sessionChromedrivers), function (context, cb) {
    logger.debug("Stopping chromedriver for context " + context);
    // stop listening for the stopped state event
    this.sessionChromedrivers[context].removeAllListeners(Chromedriver.EVENT_CHANGED);
    this.sessionChromedrivers[context].stop().nodeify(function (err) {
      if (err) logger.warn("Error stopping Chromedriver: " + err.message);
      // chromedriver isn't valid anymore, so remove it from context list
      delete this.sessionChromedrivers[context];
      cb();
    }.bind(this));
  }.bind(this), function (err) {
    // if one of these fails, go back to last proxy state and error out
    this.restoreProxyState();
    ocb(err);
  }.bind(this));
};

androidHybrid.defaultWebviewName = function () {
  return this.WEBVIEW_BASE + this.appProcess;
};

androidHybrid.initAutoWebview = function (cb) {
  if (this.args.autoWebview) {
    logger.debug('Setting auto webview');
    var viewName = this.defaultWebviewName();
    var timeout = (this.args.autoWebviewTimeout) || 2000;
    this.setContext(viewName, function (err, res) {
      if (err && res.status !== status.codes.NoSuchContext.code) return cb(err);
      if (res.status === status.codes.Success.code) return cb();
      setTimeout(function () {
        logger.debug("Retrying context switch with timeout '" + timeout + "'");
        this.setContext(viewName, cb);
      }.bind(this), timeout);
    }.bind(this));
  } else {
    cb();
  }
};

// get the correct chromedriver executable path based on our system
// TODO: don't download/build chromedriver in reset.sh, instead let this be
// something that the appium-chromedriver package manages
androidHybrid.initChromedriverPath = function (cb) {
  if (this.args.chromedriverExecutable) {
    cb();
  } else {
    var setPath = function (platform, executable) {
      this.args.chromedriverExecutable = path.resolve(__dirname, "..", "..",
          "..", "build", "chromedriver", platform, executable);
      logger.debug("Set chromedriver binary as: " + this.args.chromedriverExecutable);
    }.bind(this);
    if (isLinux) {
      logger.debug("Determining linux architecture");
      exec("uname -m", function (err, stdout) {
        var executable;
        if (err) return cb(err);
        if (stdout.trim() === "i686") {
          executable = "chromedriver32";
        } else {
          executable = "chromedriver64";
        }
        setPath("linux", executable);
        cb();
      });
    } else {
      var executable = isWindows ? "chromedriver.exe" : "chromedriver";
      var platform = isWindows ? "windows" : "mac";
      setPath(platform, executable);
      cb();
    }
  }
};

module.exports = androidHybrid;

import { CliTrackerController } from 'azk/cli/cli_tracker_controller.js';
import { Helpers } from 'azk/cli/helpers';
import { _, config, lazy_require, log } from 'azk';
import { defer, asyncUnsubscribe } from 'azk/utils/promises';
import { subscribe } from 'azk/utils/postal';

var lazy = lazy_require({
  Client      : [ 'azk/agent/client' ],
  spawn       : ['child-process-promise'],
  net         : 'net',
  VMController: 'azk/cmds/vm',
});

class Agent extends CliTrackerController {
  get docker() {
    return require('azk/docker').default;
  }

  index(opts) {
    return this.callAgent(opts);
  }

  callAgent(opts) {
    var params = {
      action: _.head(this.route.actions) || opts.action
    };
    // Create a progress output
    var view = Helpers.vmStartProgress(this.ui);
    var _subscription = subscribe('#.status', (data) => {
      view(data);
    });

    return asyncUnsubscribe(this, _subscription, function* () {
      if (params.action === 'start') {
        // And no running
        var status = yield lazy.Client.status(opts.action, false);
        if (!status.agent) {
          // Run in daemon mode
          if (!opts['no-daemon']) {
            var args = _.clone(this.args);
            var cmd  = `azk agent-daemon --no-daemon "${args.join('" "')}"`;
            return this._runDaemon(cmd);
          }

          // Save pid and connect signals
          var stopping = false;
          this._captureSignal(() => {
            if (!stopping) {
              stopping = true;
              _subscription.unsubscribe();
              view({
                type  : "status",
                status: "stopped"
              });
              status.pid.unlink();
              this.ui.exit(1);
            }
          });
          status.pid.update(process.pid);

          // Check and load configures
          this.ui.warning('status.agent.wait');
          params.configs = yield Helpers.configure(this.ui);

          // Remove and adding vm (to refresh vm configs)
          if (config('agent:requires_vm') && !opts['no-reload-vm']) {
            var cmd_vm = new lazy.VMController({ ui: this.ui });
            yield cmd_vm.index({ action: 'remove', fail: () => {} });
          }

          // Generate a new tracker agent session id
          this.ui.tracker.generateNewAgentSessionId();
          this._trackStart();
        }
      }

      // Changing directory for security
      process.chdir(config('paths:azk_root'));

      // Call action in agent
      var promise = lazy.Client[params.action](params);
      return promise.then((result) => {
        if (params.action != "status") {
          return result;
        }
        return (result.agent) ? 0 : 1;
      });
    });
  }

  _runDaemon(cmd) {
    return defer((resolve) => {
      var opts  = {
        detached: true,
        stdio: [ process.stdin, process.stdout, process.stderr ]
      };

      var child = this.ui.execSh(cmd, opts, (err) => {
        resolve(err ? err.code : 0);
      });

      this._captureSignal((signal) => {
        child.kill(signal);
      });
    });
  }

  _captureSignal(handler) {
    process.on('SIGTERM', () => handler('SIGTERM'));
    process.on('SIGINT' , () => handler('SIGINT'));
    process.on('SIGQUIT', () => handler('SIGQUIT'));
  }

  _trackStart() {
    // use VM?
    var _subscription = subscribe("agent.agent.started.event", (/* data, envelope */) => {
      // auto-unsubscribe
      _subscription.unsubscribe();

      var vm_data = {};

      if (config("agent:requires_vm")) {
        vm_data = {
          cpus: config("agent:vm:cpus"),
          memory: config("agent:vm:memory")
        };
      }

      // Track agent start
      this.docker.version().then((result) => {
        this.addDataToTracker({
          vm: vm_data,
          docker: {
            version: result
          }
        });

        return this.sendTrackerData();
      }, (error) => {
        log.info(error);
      });
    });
  }
}

module.exports = Agent;

import { _, Q, path, fs, config, log, defer, async } from 'azk';
import { net } from 'azk/utils';
var MemoryStream = require('memorystream');

var forever = require('forever-monitor');
var MemcachedDriver = require('memcached');

// TODO: Reaplce forever for a better solution :/
var Balancer = {
  memcached: null,
  hipache  : null,
  mem_client : null,

  get memCached() {
    if (!this.mem_client) {
      var socket = config('paths:memcached_socket');
      this.mem_client = new MemcachedDriver(socket);
    }
    return this.mem_client;
  },

  getBackends(host) {
    var key = 'frontend:' + host;
    return Q.ninvoke(this.memCached, 'get', key).then((entries) => {
      return entries ? entries : [host];
    });
  },

  addBackend(hosts, backend) {
    var self = this;
    return async(function* () {
      for(var host of (_.isArray(hosts) ? hosts : [hosts])) {
        var key = 'frontend:' + host
        var entries = yield self.getBackends(host);
        entries = self._removeEntry(entries, backend);
        entries.push(backend);
        yield Q.ninvoke(self.memCached, 'set', key, entries, 0);
      }
    });
  },

  removeBackend(hosts, backend) {
    var self = this;
    return async(function* () {
      for(var host of (_.isArray(hosts) ? hosts : [hosts])) {
        var key = 'frontend:' + host;
        var entries = yield self.getBackends(host);
        entries = self._removeEntry(entries, backend);
        yield Q.ninvoke(self.memCached, 'set', key, entries, 0);
      }
    });
  },

  _removeEntry(entries, backend) {
    return _.filter(entries, (entry) => { return entry != backend });
  },

  start() {
    var self = this;
    return async(this, function* () {
      if (!this.isRunnig()) {
        var socket = config('paths:memcached_socket');
        var ip     = net.calculateGatewayIp(config("agent:vm:ip"))
        var port   = yield net.getPort();
        yield this.start_memcached(socket);
        yield this.start_hipache(ip, port, socket);
        yield self.start_socat(ip, port);
      }
    });
  },

  start_socat(ip, port) {
    return async(this, function* () {
      var Manifest = require('azk/manifest').Manifest;
      var manifest = new Manifest(config('paths:azk_root'), true);
      var system   = manifest.system('balancer_redirect', true);
      system.add_env('BALANCER_IP', ip);
      system.add_env('BALANCER_PORT', port);

      var stdout = new MemoryStream();
      var output = "";
      stdout.on('data', (data) => {
        output += data.toString();
      });

      var result = yield system.scale(1, stdout, true);
      if (!result) {
        throw new Error('Fail to start balancer: ' + output);
      }
    });
  },

  start_hipache(ip, port, socket) {
    var pid  = config("paths:hipache_pid");
    var file = this._check_config(ip, port, socket);
    var cmd = [ 'nvm', 'hipache', '--config', file ];

    log.info("starting hipache");
    return this._start_service(cmd, pid).then((child) => {
      this.hipache = child;
      log.info("hipache started in %s port with file config", port, file);
      child.on('stop', () => {
        log.info('hipache stoped');
      });
      child.on('exit:code', (code) => {
        if (code && code != 0) {
          log.error('hipache exit code: ' + code);
        }
      });
      child.on('stdout', (data) => {
        log.info('hipache: %s', data.toString().trim());
      });
      child.on('stderr', (data) => {
        log.info('hipache: %s', data.toString().trim());
      });
    });
  },

  start_memcached(socket) {
    var pid = config("paths:memcached_pid");
    var cmd = [ 'nvm', 'memcachedjs', '--socket', socket ];

    log.info("starting memcachedjs");
    return this._start_service(cmd, pid).then((child) => {
      this.memcached = child;
      log.info("memcachedjs started in socket: ", socket);
      child.on('stop', () => {
        log.info('memcached stoped');
      });
      child.on('exit:code', (code) => {
        if (code && code != 0) {
          log.error('memcached exit code: ' + code);
        }
      });
      child.on('stdout', (data) => {
        log.info('memcached: %s', data.toString().trim());
      });
      child.on('stderr', (data) => {
        log.info('memcached: %s', data.toString().trim());
      });
    });
  },

  stop() {
    if (this.isRunnig()) {
      log.debug("call to stop balancer");
      return async(this, function* () {
        yield defer((resolve) => {
          if (this.hipache && this.hipache.running) {
            log.debug("call to stop balancer: hipache");
            this.hipache.on('stop', resolve);
            process.kill(this.hipache.pid);
          } else {
            resolve();
          }
        });
        yield defer((resolve) => {
          if (this.memcached && this.memcached.running) {
            log.debug("call to stop balancer: memcached");
            this.memcached.on('stop', resolve);
            process.kill(this.memcached.pid);
          } else {
            resolve();
          }
        });
      });
    } else {
      return Q();
    }
  },

  isRunnig() {
    return (
      (this.hipache && this.hipache.running) ||
      (this.memcached && this.memcached.running)
    );
  },

  _start_service(cmd, pid) {
    cmd = [path.join(config('paths:azk_root'), 'bin', 'azk'), ...cmd];
    return defer((resolve, reject, notify) => {
      var child = forever.start(cmd, {
        max : 1,
        silent : true,
        pidFile: pid
      });

      child.on('exit:code', () => {
        reject();
        process.kill(process.pid);
      });
      child.on('start', () => resolve(child));
    });
  },

  _check_config(ip, port, memcached_socket) {
    var file   = config('paths:balancer_file');

    var data = {
      server: {
        accessLog: "./data/logs/hipache_access.log",
        workers: 3,
        maxSockets: 100,
        deadBackendTTL: 30
      },
      http: {
        port: port,
        bind: ["127.0.0.1", ip, "::1"]
      },
      driver: ["memcached://" + memcached_socket]
    }

    // set content
    fs.writeFileSync(file, JSON.stringify(data, null, '  '));
    return file;
  }
}

export { Balancer }


var assert = require('assert');
var connect = require('connect');
var http = require('http');

var server = require('../mockserver').server;
server.listen(8000);

suite("Default subscriber", function() {

  function cons_topic() {
    return "http://example.com/" + require('crypto').randomBytes(4).toString('hex');
  }

  var listener, app, secret, httpserv;
  setup(function(done) {
    secret = require('crypto').randomBytes(16).toString('base64');
    listener = require('../index').createSubscriber(
      {host: 'http://localhost:8001',
       prefix: '/snrubtest',
       secret: secret});
    app = connect(
      listener.middleware()
    );
    httpserv = http.createServer(app);
    httpserv.listen(8001, done);
  });
  teardown(function(done) {
    httpserv.on('close', done);
    httpserv.close();
  });

  test("subscribeOK", function(done) {
    var topic = cons_topic();
    listener.subscribe("http://localhost:8000/subscribeOK",
                       topic,
                       {},
                       function(_path) {
                       },
                       function(err) {
                         done("Failed initial request " + JSON.stringify(err));
                       });
    listener.on('subscribe', function(t) {
      if (t === topic) {
        done();
      }
      else {
        assert.fail(topic, t, "Subscribed topic not the same");
      }
    });
    listener.on('error', function(err) {
      done("Failed subscribe step two " + JSON.stringify(err));
    });
  });

  test("404", function(done) {
    var topic = cons_topic();
    listener.subscribe("http://localhost:8000/subscribe404",
                       topic,
                       {},
                       function(_path) {
                         done("Expected fail");
                       },
                       function (err) {
                         done();
                       });
    listener.on('subscribe', function() {
      done("Expected fail");
    });
    listener.on('error', function() {
      done("Expected fail in first callback");
    });
  });

  test("lease expires", function(done) {
    var topic = cons_topic();
    // we cheat and set a negative lease, in the knowledge that this
    // will give an immediately-expiring token.
    listener.subscribe("http://localhost:8000/subscribeOK",
                       topic,
                       {leaseSeconds: -600, noAuto: true},
                       function () {
                       },
                       function () {
                         done("Expected success on first step.");
                       });
    listener.on('subscribe', function() {
      done("Expected failure to verify");
    });
    listener.on('error', function() {
      done();
    });
  });

});

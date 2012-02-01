var snrub = require('./lib/listener');
var connect = require('connect');

var secret = "great big secret";

exports.listener = snrub.createListener("http://localhost:8080",
                                        "/snrub",
                                        snrub.cryptoPathProvider(secret),
                                        snrub.cryptoTokenProvider(secret));
exports.server = connect(
  connect.logger(),
  exports.listener.middleware()
);

var Router = require('../helpers/router.js'),
	async = require('async'),
	request = require('request'),
	ip = require('ip'),
	util = require('util'),
	_ = require('underscore'),
	zlib = require('zlib'),
	extend = require('extend'),
	crypto = require('crypto'),
	bignum = require('../helpers/bignum.js'),
	sandboxHelper = require('../helpers/sandbox.js');

// Private fields
var modules, library, self, private = {}, shared = {};

private.headers = {};
private.loaded = false;
private.messages = {};

// Constructor
function Transport(cb, scope) {
	library = scope;
	self = this;
	self.__private = private;
	private.attachApi();

	setImmediate(cb, null, self);
}

// Private methods
private.attachApi = function () {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules && private.loaded) return next();
		res.status(500).send({success: false, error: "Blockchain is loading"});
	});

	router.use(function (req, res, next) {
		var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

		if (peerIp == "127.0.0.1") {
			return next();
		}

		if (!peerIp) {
			return res.status(500).send({success: false, error: "Wrong header data"});
		}

		req.headers['port'] = parseInt(req.headers['port']);
		req.headers['share-port'] = parseInt(req.headers['share-port']);

		req.sanitize(req.headers, {
			type: "object",
			properties: {
				port: {
					type: "integer",
					minimum: 1,
					maximum: 65535
				},
				os: {
					type: "string",
					maxLength: 64
				},
				'share-port': {
					type: 'integer',
					minimum: 0,
					maximum: 1
				},
				'version': {
					type: 'string',
					maxLength: 11
				}
			},
			required: ["port", 'share-port', 'version']
		}, function (err, report, headers) {
			if (err) return next(err);
			if (!report.isValid) return res.status(500).send({status: false, error: report.issues});

			var peer = {
				ip: ip.toLong(peerIp),
				port: headers.port,
				state: 2,
				os: headers.os,
				sharePort: Number(headers['share-port']),
				version: headers.version
			};

			if (req.body && req.body.dappid) {
				peer.dappid = req.body.dappid;
			}

			if (peer.port > 0 && peer.port <= 65535 && peer.version == library.config.version) {
				modules.peer.update(peer);
			}

			next();
		});

	});

	router.get('/list', function (req, res) {
		res.set(private.headers);
		modules.peer.list({limit: 100}, function (err, peers) {
			return res.status(200).json({peers: !err ? peers : []});
		})
	});

	router.get("/blocks/common", function (req, res, next) {
		res.set(private.headers);

		req.sanitize(req.query, {
			type: "object",
			properties: {
				max: {
					type: 'integer'
				},
				min: {
					type: 'integer'
				},
				ids: {
					type: 'string',
					format: 'splitarray'
				}
			},
			required: ['max', 'min', 'ids']
		}, function (err, report, query) {
			if (err) return next(err);
			if (!report.isValid) return res.json({success: false, error: report.issue});


			var max = query.max;
			var min = query.min;
			var ids = query.ids.split(",").filter(function (id) {
				return /^\d+$/.test(id);
			});
			var escapedIds = ids.map(function (id) {
				return "'" + id + "'";
			});

			if (!escapedIds.length) {
				report = library.scheme.validate(req.headers, {
					type: "object",
					properties: {
						port: {
							type: "integer",
							minimum: 1,
							maximum: 65535
						}
					},
					required: ['port']
				});

				var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
				var peerStr = peerIp ? peerIp + ":" + (isNaN(parseInt(req.headers['port'])) ? 'unkwnown' : parseInt(req.headers['port'])) : 'unknown';
				library.logger.log('Invalid common block request, ban 60 min', peerStr);

				if (report) {
					modules.peer.state(ip.toLong(peerIp), RequestSanitizer.int(req.headers['port']), 0, 3600);
				}

				return res.json({success: false, error: "Invalid block id sequence"});
			}

			library.dbLite.query("select max(height), id, previousBlock, timestamp from blocks where id in (" + escapedIds.join(',') + ") and height >= $min and height <= $max", {
				"max": max,
				"min": min
			}, {
				"height": Number,
				"id": String,
				"previousBlock": String,
				"timestamp": Number
			}, function (err, rows) {
				if (err) {
					return res.json({success: false, error: "Database error"});
				}

				var commonBlock = rows.length ? rows[0] : null;
				return res.json({success: true, common: commonBlock});
			});
		});
	});

	router.get("/blocks", function (req, res) {
		res.set(private.headers);

		req.sanitize(req.query, {
			type: 'object',
			properties: {lastBlockId: {type: 'string'}}
		}, function (err, report, query) {
			if (err) return next(err);
			if (!report.isValid) return res.json({success: false, error: report.issues});

			// Get 1400+ blocks with all data (joins) from provided block id
			var blocksLimit = 1440;

			modules.blocks.loadBlocksData({
				limit: blocksLimit,
				lastId: query.lastBlockId
			}, {plain: true}, function (err, data) {
				res.status(200);
				if (err) {
					return res.json({blocks: ""});
				}

				res.json({blocks: data});

			});
		});
	});

	router.post("/blocks", function (req, res) {
		res.set(private.headers);

		var report = library.scheme.validate(req.headers, {
			type: "object",
			properties: {
				port: {
					type: "integer",
					minimum: 1,
					maximum: 65535
				}
			},
			required: ['port']
		});

		try {
			var block = library.logic.block.objectNormalize(req.body.block);
		} catch (e) {
			var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
			var peerStr = peerIp ? peerIp + ":" + (isNaN(parseInt(req.headers['port'])) ? 'unkwnown' : parseInt(req.headers['port'])) : 'unknown';
			library.logger.log('Block ' + (block ? block.id : 'null') + ' is not valid, ban 60 min', peerStr);

			if (peerIp && report) {
				modules.peer.state(ip.toLong(peerIp), parseInt(req.headers['port']), 0, 3600);
			}

			return res.sendStatus(200);
		}

		library.bus.message('receiveBlock', block);

		res.sendStatus(200);
	});

	router.post('/signatures', function (req, res) {
		res.set(private.headers);

		library.scheme.validate(req.body, {
			type: "object",
			properties: {
				signature: {
					type: "object",
					properties: {
						transaction: {
							type: "string"
						},
						signature: {
							type: "string",
							format: "signature"
						}
					},
					required: ['transaction', 'signature']
				}
			},
			required: ['signature']
		}, function (err) {
			if (err) {
				return res.status(200).json({success: false, error: "Validation error"});
			}

			modules.multisignatures.processSignature(req.body.signature, function (err) {
				if (err) {
					return res.status(200).json({success: false, error: "Process signature error"});
				} else {
					return res.status(200).json({success: true});
				}
			});
		});
	});

	router.get('/signatures', function (req, res) {
		res.set(private.headers);

		var unconfirmedList = modules.transactions.getUnconfirmedTransactionList();
		var signatures = [];

		async.eachSeries(unconfirmedList, function (trs, cb) {
			if (trs.signatures && trs.signatures.length) {
				signatures.push({
					transaction: trs.id,
					signatures: trs.signatures
				});
			}

			setImmediate(cb);
		}, function () {
			return res.status(200).json({success: true, signatures: signatures});
		});
	});

	router.get("/transactions", function (req, res) {
		res.set(private.headers);
		// Need to process headers from peer
		res.status(200).json({transactions: modules.transactions.getUnconfirmedTransactionList()});
	});

	router.post("/transactions", function (req, res) {
		res.set(private.headers);

		var report = library.scheme.validate(req.headers, {
			type: "object",
			properties: {
				port: {
					type: "integer",
					minimum: 1,
					maximum: 65535
				}
			},
			required: ['port']
		});

		try {
			var transaction = library.logic.transaction.objectNormalize(req.body.transaction);
		} catch (e) {
			var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
			var peerStr = peerIp ? peerIp + ":" + (isNaN(req.headers['port']) ? 'unknown' : req.headers['port']) : 'unknown';
			library.logger.log('Received transaction ' + (transaction ? transaction.id : 'null') + ' is not valid, ban 60 min', peerStr);

			if (peerIp && report) {
				modules.peer.state(ip.toLong(peerIp), req.headers['port'], 0, 3600);
			}

			return res.status(200).json({success: false, message: "Invalid transaction body"});
		}

		library.balancesSequence.add(function (cb) {
			modules.transactions.receiveTransactions([transaction], cb);
		}, function (err) {
			if (err) {
				res.status(200).json({success: false, message: err});
			} else {
				res.status(200).json({success: true});
			}
		});
	});

	router.get('/height', function (req, res) {
		res.set(private.headers);
		res.status(200).json({
			height: modules.blocks.getLastBlock().height
		});
	});

	router.post("/dapp/message", function (req, res) {
		res.set(private.headers);

		try {
			if (!req.body.dappid) {
				return res.status(200).json({success: false, message: "missed dappid"});
			}
			if (!req.body.timestamp || !req.body.hash) {
				return res.status(200).json({
					success: false,
					message: "missed hash sum"
				});
			}
			var newHash = private.hashsum(req.body.body, req.body.timestamp);
			if (newHash !== req.body.hash) {
				return res.status(200).json({success: false, message: "wrong hash sum"});
			}
		} catch (e) {
			return res.status(200).json({success: false, message: e.toString()});
		}

		if (private.messages[req.body.hash]) {
			return res.status(200);
		}

		private.messages[req.body.hash] = true;

		modules.dapps.message(req.body.dappid, req.body.body, function (err, body) {
			if (!err && body.error) {
				err = body.error;
			}

			if (err) {
				return res.status(200).json({success: false, message: err});
			}

			library.bus.message('message', req.body, true);
			res.status(200).json(extend({}, body, {success: true}));
		});
	});

	router.post("/dapp/request", function (req, res) {
		res.set(private.headers);

		try {
			if (!req.body.dappid) {
				return res.status(200).json({success: false, message: "missed dappid"});
			}
			if (!req.body.timestamp || !req.body.hash) {
				return res.status(200).json({
					success: false,
					message: "missed hash sum"
				});
			}
			var newHash = private.hashsum(req.body.body, req.body.timestamp);
			if (newHash !== req.body.hash) {
				return res.status(200).json({success: false, message: "wrong hash sum"});
			}
		} catch (e) {
			return res.status(200).json({success: false, message: e.toString()});
		}

		modules.dapps.request(req.body.dappid, req.body.body.method, req.body.body.path, req.body.body.query, function (err, body) {
			if (!err && body.error) {
				err = body.error;
			}

			if (err) {
				return res.status(200).json({success: false, message: err});
			}

			res.status(200).json(extend({}, body, {success: true}));
		});
	});

	router.use(function (req, res, next) {
		res.status(500).send({success: false, error: "API endpoint not found"});
	});

	library.network.app.use('/peer', router);

	library.network.app.use(function (err, req, res, next) {
		if (!err) return next();
		library.logger.error(req.url, err.toString());
		res.status(500).send({success: false, error: err.toString()});
	});
}

private.hashsum = function (obj) {
	var buf = new Buffer(JSON.stringify(obj), 'utf8');
	var hashdig = crypto.createHash('sha256').update(buf).digest();
	var temp = new Buffer(8);
	for (var i = 0; i < 8; i++) {
		temp[i] = hashdig[7 - i];
	}

	return bignum.fromBuffer(temp).toString();
}

// Public methods
Transport.prototype.broadcast = function (config, options, cb) {
	config.limit = config.limit || 1;
	modules.peer.list(config, function (err, peers) {
		if (!err) {
			async.eachLimit(peers, 3, function (peer, cb) {
				self.getFromPeer(peer, options);

				setImmediate(cb);
			}, function () {
				cb && cb(null, {body: null, peer: peers});
			})
		} else {
			cb && setImmediate(cb, err);
		}
	});
}

Transport.prototype.getFromRandomPeer = function (config, options, cb) {
	if (typeof options == 'function') {
		cb = options;
		options = config;
		config = {};
	}
	config.limit = 1;
	async.retry(20, function (cb) {
		modules.peer.list(config, function (err, peers) {
			if (!err && peers.length) {
				var peer = peers[0];
				self.getFromPeer(peer, options, cb);
			} else {
				return cb(err || "No peers in db");
			}
		});
	}, function (err, results) {
		cb(err, results)
	});
}

/**
 * Send request to selected peer
 * @param {object} peer Peer object
 * @param {object} options Request lib params with special value `api` which should be string name of peer's module
 * web method
 * @param {function} cb Result Callback
 * @returns {*|exports} Request lib request instance
 * @private
 * @example
 *
 * // Send gzipped request to peer's web method /peer/blocks.
 * .getFromPeer(peer, { api: '/blocks', gzip: true }, function (err, data) {
 * 	// Process request
 * });
 */
Transport.prototype.getFromPeer = function (peer, options, cb) {
	var url;
	if (options.api) {
		url = '/peer' + options.api
	} else {
		url = options.url;
	}

	var req = {
		url: 'http://' + ip.fromLong(peer.ip) + ':' + peer.port + url,
		method: options.method,
		json: true,
		headers: _.extend({}, private.headers, options.headers),
		timeout: library.config.peers.options.timeout
	};
	if (Object.prototype.toString.call(options.data) === "[object Object]" || util.isArray(options.data)) {
		req.json = options.data;
	} else {
		req.body = options.data;
	}


	return request(req, function (err, response, body) {
		if (err || response.statusCode != 200) {
			library.logger.debug('Request', {
				url: req.url,
				statusCode: response ? response.statusCode : 'unknown',
				err: err
			});

			if (peer) {
				if (err && (err.code == "ETIMEDOUT" || err.code == "ESOCKETTIMEDOUT" || err.code == "ECONNREFUSED")) {
					modules.peer.remove(peer.ip, peer.port, function (err) {
						if (!err) {
							library.logger.info('Removing peer ' + req.method + ' ' + req.url)
						}
					});
				} else {
					if (!options.not_ban) {
						modules.peer.state(peer.ip, peer.port, 0, 600, function (err) {
							if (!err) {
								library.logger.info('Ban 10 min ' + req.method + ' ' + req.url);
							}
						});
					}
				}
			}
			cb && cb(err || ('request status code' + response.statusCode));
			return;
		}

		response.headers['port'] = parseInt(response.headers['port']);
		response.headers['share-port'] = parseInt(response.headers['share-port']);

		var report = library.scheme.validate(response.headers, {
			type: "object",
			properties: {
				os: {
					type: "string",
					maxLength: 64
				},
				port: {
					type: "integer",
					minimum: 1,
					maximum: 65535
				},
				'share-port': {
					type: "integer",
					minimum: 0,
					maximum: 1
				},
				version: {
					type: "string",
					maxLength: 11
				}
			},
			required: ['port', 'share-port', 'version']
		});

		if (!report) {
			return cb && cb(null, {body: body, peer: peer});
		}

		var port = response.headers['port'];
		if (port > 0 && port <= 65535 && response.headers['version'] == library.config.version) {
			modules.peer.update({
				ip: peer.ip,
				port: port,
				state: 2,
				os: response.headers['os'],
				sharePort: Number(!!response.headers['share-port']),
				version: response.headers['version']
			});
		}

		cb && cb(null, {body: body, peer: peer});
	});
}

Transport.prototype.sandboxApi = function (call, args, cb) {
	sandboxHelper.callMethod(shared, call, args, cb);
}

// Events
Transport.prototype.onBind = function (scope) {
	modules = scope;

	private.headers = {
		os: modules.system.getOS(),
		version: modules.system.getVersion(),
		port: modules.system.getPort(),
		'share-port': modules.system.getSharePort()
	}
}

Transport.prototype.onBlockchainReady = function () {
	private.loaded = true;
}

Transport.prototype.onSignature = function (signature, broadcast) {
	if (broadcast) {
		self.broadcast({limit: 100}, {api: '/signatures', data: {signature: signature}, method: "POST"});
		library.network.io.sockets.emit('signature/change', {});
	}
}

Transport.prototype.onUnconfirmedTransaction = function (transaction, broadcast) {
	if (broadcast) {
		self.broadcast({limit: 100}, {api: '/transactions', data: {transaction: transaction}, method: "POST"});
		library.network.io.sockets.emit('transactions/change', {});
	}
}

Transport.prototype.onNewBlock = function (block, broadcast) {
	if (broadcast) {
		self.broadcast({limit: 100}, {api: '/blocks', data: {block: block}, method: "POST"});
		library.network.io.sockets.emit('blocks/change', {});
	}
}

Transport.prototype.onMessage = function (msg, broadcast) {
	if (broadcast) {
		self.broadcast({limit: 100, dappid: msg.dappid}, {api: '/dapp/message', data: msg, method: "POST"});
	}
}

Transport.prototype.cleanup = function (cb) {
	private.loaded = false;
	cb();
}

// Shared
shared.message = function (msg, cb) {
	msg.timestamp = (new Date()).getTime();
	msg.hash = private.hashsum(msg.body, msg.timestamp);

	self.broadcast({limit: 100, dappid: msg.dappid}, {api: '/dapp/message', data: msg, method: "POST"});

	cb(null, {});
}

shared.request = function (msg, cb) {
	msg.timestamp = (new Date()).getTime();
	msg.hash = private.hashsum(msg.body, msg.timestamp);

	if (msg.body.peer) {
		self.getFromPeer({ip: msg.body.peer.ip, port: msg.body.peer.port}, {
			api: '/dapp/request',
			data: msg,
			method: "POST"
		}, cb);
	} else {
		self.getFromRandomPeer({dappid: msg.dappid}, {api: '/dapp/request', data: msg, method: "POST"}, cb);
	}
}

// Export
module.exports = Transport;

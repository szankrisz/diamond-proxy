// Import the necessary stuff.
var http = require('http'),
    https = require('https'),
    url = require('url'),
    httpRequest = require('request'),
    tunnel = require('tunnel'),
    websocket = require('websocket'),
    WebSocketServer = websocket.server,
    WebSocketClient = websocket.client;

// Parse command line arguments
var param_isProxySecure, param_proxyUrl, param_isSecure, param_targetUrl, param_targetWsUrl, param_portNumbers;
(function() {
    function help() {
        console.log('Diamond (Reverse) Proxy\n\n');
        console.log('\tReverse proxy server for forwarding HTTP and WebSockets traffic coming in over multiple channels to a single target server. Usage:\n');
        console.log('\t\tdiamondproxy [--proxy <proxy_addr>] <host> <port list>\n');
        console.log('\t\t<host>: The host name or IP to connect to. If starts with \'https\' then secure channels are used to connect to the target server for both HTTP and WebSockets channels.');
        console.log('\t\t<port list>: The list of ports to listen on.\n\n');
        console.log('\tExample:\n');
        console.log('\t\tdiamondproxy https://www.example.com:8443 8081 8082 8083\n');
        console.log('\t\t\tProxies all traffic coming in on ports 8081-8083 over a secure channel (HTTPS or WSS) to port 8443 of www.example.com.\n');
    }

    // Check argument count first.
    if (process.argv.length < 4) {
        help();
        process.exit(1);
    }

    var k = 2;

    // Look for proxy setting.
    if (process.argv[k] == '--proxy') {
        k++;
        var proxyOption = process.argv[k++];
        if (!proxyOption) {
            console.error('Proxy has not been specified');
            process.exit(1);
        }

        param_proxyUrl = url.parse(proxyOption.toLowerCase());
        param_isProxySecure = param_proxyUrl.protocol == 'https:';

        console.log('Using proxy server: ' + param_proxyUrl.href);
    }

    // Parse host name.
    param_targetUrl = url.parse(process.argv[k++]);
    param_isSecure = param_targetUrl.protocol == 'https:';
    console.log('Reverse proxying to host: ' + param_targetUrl.href);

    // Create the WS target url.
    if (param_isSecure)
        param_targetWsUrl = param_targetUrl.href.replace(/https:/, 'wss:');
    else
        param_targetWsUrl = param_targetUrl.href.replace(/http:/, 'ws:');
    param_targetWsUrl = url.parse(param_targetWsUrl);

    // Parse port numbers.
    param_portNumbers = [];
    for (var i = k; i < process.argv.length; i++) {
        var arg = process.argv[i];
        var port = parseInt(arg);
        if (!port || port < 0 || port > 65535) {
            console.error('Invalid port number \'' + arg + '\'. It must be a number in the 0-65535 range.');
            process.exit(1);
        }

        param_portNumbers.push(port);
    }
})();

// Configure tunneling agent.
var tunnelingAgent = param_proxyUrl ?
    (param_isSecure ? (param_isProxySecure ? tunnel.httpsOverHttps : tunnel.httpsOverHttp) : (param_isProxySecure ? tunnel.httpOverHttps : tunnel.httpOverHttp))
    ({
        proxy: {
            host: param_proxyUrl.host,
            port: param_proxyUrl.port
        }
    }) : undefined;

// Begin proxying.
function setupProxy(port) {
    // Initialize HTT{ server.
    var httpServer = http.createServer(function(request, response) {
        // Dump request details first.
        console.log('--------------------------------');
        console.log('---> Receiving request on port ' + port);
        console.log('\t' + request.method + ' ' + request.url);

        // Collect and dump headers.
        var headers = {};
        if (request.rawHeaders) {
            for (var i = 0; i < request.rawHeaders.length; i += 2) {
                var key = request.rawHeaders[i];
                var value = request.rawHeaders[i + 1];
                var skipped = key.toLowerCase() == 'host';
                if (!skipped)
                    headers[key] = value;

                console.log('\t' + (skipped ? '(skipped) ' : '') + key + ': ' + value);
            }
        }

        // Proxy everything to the target server.
        console.log('---> Forwarding to ' + url.resolve(param_targetUrl.href, request.url) + '\n');
        var targetRequest = (param_isSecure ? https : http).request({
            host: param_targetUrl.host,
            port: param_targetUrl.port ? param_targetUrl.port : undefined,
            path: request.url,
            method: request.method,
            headers: headers,
            agent: tunnelingAgent,
            rejectUnauthorized: false
        }, function(targetResponse) {
            console.log('---> Sending back response\n');
            console.log('\t' + targetResponse.statusCode);

            var headers = {};
            for (var key in targetResponse.headers) {
                headers[key] = targetResponse.headers[key];
                console.log('\t' + key + ': ' + targetResponse.headers[key]);
            }

            // Rewrite cookies where necessary.
            var setCookieHdr = headers['set-cookie'];
            if (setCookieHdr) {
                if (!(setCookieHdr instanceof Array))
                    setCookieHdr = [setCookieHdr];

                var modifiedSetCookieHdr = [];
                for (var i = 0; i < setCookieHdr.length; i++)
                    modifiedSetCookieHdr.push(setCookieHdr[i].replace(/domain=[a-zA-Z0-9.]+;?/gi, ''));
                headers['set-cookie'] = modifiedSetCookieHdr;
            }

            response.writeHead(targetResponse.statusCode, headers);
            targetResponse.pipe(response);
        }).on('error', function(err) {
            console.error('!!! Error receiving response: ' + err);
            response.statusCode = 500;
            response.end();
        });

        request.pipe(targetRequest);
    });

    // Initialize WebSockets server.
    var wsServer = new WebSocketServer({
        httpServer: httpServer,
        autoAcceptConnections: false
    });

    wsServer.on('request', function(request) {
        console.log('--------------------------------');
        console.log('---> Receiving WebSocket connection on port: ' + port);

        // Collect and dump headers.
        var headers = {};
        if (request.httpRequest && request.httpRequest.rawHeaders) {
            for (var i = 0; i < request.httpRequest.rawHeaders.length; i += 2) {
                var key = request.httpRequest.rawHeaders[i];
                var value = request.httpRequest.rawHeaders[i + 1];
                var lKey = key.toLowerCase();
                var skipped = lKey == 'host' || lKey == 'upgrade' || lKey == 'connection' || lKey.indexOf('sec-websocket-') === 0;
                if (!skipped)
                    headers[lKey] = value;

                console.log('\t' + (skipped ? '(skipped) ' : '') + key + ': ' + value);
            }
        }

        // Create the client and configure it.
        var wsClient = new WebSocketClient();
        wsClient.on('connect', function(webSocketTargetConnection) {
            // Accept the client connection.
            console.log('---> Target server connected. Accepting client connection. Chosen subprotocol: ' + webSocketTargetConnection.procotol);
            var webSocketConnection = request.accept(webSocketTargetConnection.procotol, '*');

            // Message exchange.
            webSocketConnection.on('message', function(message) {
                // Message from client to target server.
                console.log('\tMessage from client -> server. Type: ' + message.type);
                if (!webSocketTargetConnection) {
                    console.log('\tConnection to server has already been closed');
                    return;
                }

                if (message.type == 'utf8') {
                    console.log('\tMessage payload: ' + (message.utf8Data && message.utf8Data.replace(/\n/g, '\t\n')));
                    webSocketTargetConnection.sendUTF(message.utf8Data);
                } else if (message.type == 'binary')
                    webSocketTargetConnection.sendBinary(message.binaryData);
            });

            webSocketTargetConnection.on('message', function(message) {
                // Message from target server to client.
                console.log('\tMessage from server -> client. Type: ' + message.type);
                if (!webSocketConnection) {
                    console.log('\tConnection to client has already been closed');
                    return;
                }

                if (message.type == 'utf8') {
                    console.log('\tMessage payload: ' + (message.utf8Data && message.utf8Data.replace(/\n/g, '\t\n')));
                    webSocketConnection.sendUTF(message.utf8Data);
                } else if (message.type == 'binary')
                    webSocketConnection.sendBinary(message.binaryData);
            });

            // Frame exchange.
            webSocketConnection.on('frame', function(webSocketFrame) {
                // Message from client to target server.
                console.log('\tFrame from client -> server');
                if (!webSocketTargetConnection) {
                    console.log('\tConnection to server has already been closed');
                    return;
                }

                webSocketTargetConnection.sendFrame(webSocketFrame);
            });

            webSocketTargetConnection.on('frame', function(message) {
                // Message from target server to client.
                console.log('\tFrame from server -> client');
                if (!webSocketConnection) {
                    console.log('\tConnection to client has already been closed');
                    return;
                }

                webSocketConnection.sendFrame(webSocketFrame);
            });

            // Exchange of close events.
            webSocketConnection.on('close', function(reasonCode, description) {
                console.log('\tClient is closing connection (reason code, description): ' + reasonCode + ', ' + description);
                if (!webSocketTargetConnection) {
                    console.log('\tConnection to server has already been closed');
                    return;
                }

                webSocketConnection = undefined;
                webSocketTargetConnection.close(1000, description);
            });

            webSocketTargetConnection.on('close', function(reasonCode, description) {
                console.log('\tServer is closing connection (reason code, description): ' + reasonCode + ', ' + description);
                if (!webSocketConnection) {
                    console.log('\tConnection to client has already been closed');
                    return;
                }

                webSocketTargetConnection = undefined;
                webSocketConnection.close(1000, description);
            });
        });

        wsClient.on('connectFailed', function(errorDescription) {
            console.log('\tFailed to connect to target server. Rejecting client connection. Error description:\n\t\t' + errorDescription);
            request.reject();
        });

        // Establish the connection.
        var wsUrl = param_targetWsUrl.href + '/' + request.resourceURL.path;
        console.log('---> Connecting with WebSockets to URL \'' + wsUrl + '\' using protocols: ' + request.requestedProtocols);

        wsClient.connect(wsUrl, request.requestedProtocols, request.origin, headers, {
            agent: tunnelingAgent
        });
    });

    // Start listening.
    httpServer.listen(port, function() {
        console.log('Diamond proxy listening on port %s.', httpServer.address().port);
    });
}

for (var i = 0; i < param_portNumbers.length; i++)
    setupProxy(param_portNumbers[i]);

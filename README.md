# Diamond (reverse) proxy

## Introduction

This is a rather simple proxy that can be used for testing purposes. It can accept connections over HTTP and WebSockets and can proxy it to HTTP/HTTPS and WebSockets/WSS endpoints. The name diamond comes from that it can listen on multiple ports but still proxy communication to the same server, as follows:

```
                          +---------------+                    +---------------+
             --- (port #A)|               |(client #A) ---     |               |
            /             |               |               \    |               |
(client)---+              | diamond proxy |                +---| target server |
            \             |               |               /    |               |
             --- (port #B)|               |(client #B) ---     |               |
                          +---------------+                    +---------------+
```

Practically, a single target server can be made to look like multiple servers from the aspect of the client and the same client can be made to look like multiple ones from the aspect of the server. This is especially handy when one wishes to communicate with a server over a channel that is incapable of handling multiple connections from the same client. An example can be a communication library that heavily relies on the HTTP cookies sent by the server to identify sessions and there's no way to configure the server to act otherwise.

## Purpose

As this reverse proxy is accepting only HTTP from the client but can still communicate over HTTPS it's intended only for development purposes. It cannot proxy HTTPS traffic and thus is unable to take part in mutual certificate authentication should the server ask for it.

## Reverse proxy behaviour

All the diamond proxy does is open a HTTP or WebSockets connection to the target server on behalf of the client. All request headers and parameters are forwarded as-is. The responses are also
streamed back to the client unmodified, except for those `Set-Cookie` headers which happen to contain a `Domain` part: in this case the proxy simply removes this attribute from the cookie.

## Usage

The diamond proxy is a NodeJS application which can be installed as follows:

```
npm install -g diamond-proxy
```

From then on the proxy can be started with the following command:
```
diamondproxy <IP or host name of target server> <port numbers to open>
```

For example, the below invocation..
```
diamondproxy www.example.com 8081 8082 8083
```

..will open all ports between 8081 and 8083 and route all traffic to `http://www.example.com`.

The host itself might contain the URI scheme `https` to indicate that secure channels are to be used. For example:
```
diamondproxy https://www.example.com:8443 8081 8082 8083
```
..will open the same ports but HTTP traffic will be routed via HTTPS to port 8443 of `www.example.com`. As such, WebSockets connections will be secured also.
// SPDX-License-Identifier: MIT
// node:http for a worker: Node's status codes and methods (find-my-way and Fastify read them)
// and `ServerResponse`, which Fastify answers through and light-my-request (Fastify's `inject`)
// subclasses the old way (`ServerResponse.call(this, req)`), so it's a function-style constructor
// over the stream polyfill's Writable. Nothing goes to a socket: the bytes are what
// light-my-request collects. There is no client here — the in-app server makes no HTTP requests
// through node:http (an AI provider call uses fetch).
import { Writable } from "node:stream";

/** Node 26's `http.STATUS_CODES`. */
export const STATUS_CODES = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  509: "Bandwidth Limit Exceeded",
  510: "Not Extended",
  511: "Network Authentication Required"
};

/** Node 26's `http.METHODS`. */
export const METHODS = ["ACL","BIND","CHECKOUT","CONNECT","COPY","DELETE","GET","HEAD","LINK","LOCK","M-SEARCH","MERGE","MKACTIVITY","MKCALENDAR","MKCOL","MOVE","NOTIFY","OPTIONS","PATCH","POST","PROPFIND","PROPPATCH","PURGE","PUT","QUERY","REBIND","REPORT","SEARCH","SOURCE","SUBSCRIBE","TRACE","UNBIND","UNLINK","UNLOCK","UNSUBSCRIBE"];

export function IncomingMessage() {
  throw new Error("http.IncomingMessage: no server sockets in a worker");
}

export function ServerResponse(req) {
  Writable.call(this);
  this.req = req;
  this.statusCode = 200;
  this.statusMessage = "";
  this.headersSent = false;
  this.sendDate = false;
  this.finished = false;
  this.socket = null;
  this.connection = null;
  this._header = null;
  this._headers = Object.create(null);
  this._names = Object.create(null); // lower-case name → as first set
}
Object.setPrototypeOf(ServerResponse.prototype, Writable.prototype);
Object.setPrototypeOf(ServerResponse, Writable);

ServerResponse.prototype._write = function (_chunk, _encoding, callback) {
  callback();
};
ServerResponse.prototype.assignSocket = function (socket) {
  this.socket = socket;
  this.connection = socket;
  this.emit("socket", socket);
};
ServerResponse.prototype.detachSocket = function () {
  this.socket = null;
  this.connection = null;
};
ServerResponse.prototype.setHeader = function (name, value) {
  if (this.headersSent) throw Object.assign(new Error("Cannot set headers after they are sent to the client"), { code: "ERR_HTTP_HEADERS_SENT" });
  const key = String(name).toLowerCase();
  this._headers[key] = value;
  this._names[key] ??= String(name);
  return this;
};
ServerResponse.prototype.appendHeader = function (name, value) {
  const key = String(name).toLowerCase();
  const cur = this._headers[key];
  const add = Array.isArray(value) ? value : [value];
  this._headers[key] = cur === undefined ? (add.length === 1 ? add[0] : add) : [...(Array.isArray(cur) ? cur : [cur]), ...add];
  this._names[key] ??= String(name);
  return this;
};
ServerResponse.prototype.getHeader = function (name) {
  return this._headers[String(name).toLowerCase()];
};
ServerResponse.prototype.getHeaders = function () {
  return Object.assign(Object.create(null), this._headers);
};
ServerResponse.prototype.getHeaderNames = function () {
  return Object.keys(this._headers);
};
ServerResponse.prototype.hasHeader = function (name) {
  return String(name).toLowerCase() in this._headers;
};
ServerResponse.prototype.removeHeader = function (name) {
  const key = String(name).toLowerCase();
  delete this._headers[key];
  delete this._names[key];
};
ServerResponse.prototype.writeHead = function (statusCode, reason, headers) {
  if (typeof reason !== "string") {
    headers = reason;
    reason = undefined;
  }
  this.statusCode = statusCode;
  this.statusMessage = reason ?? STATUS_CODES[statusCode] ?? "unknown";
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) this.appendHeader(headers[i], headers[i + 1]);
  } else if (headers) {
    for (const k of Object.keys(headers)) this.setHeader(k, headers[k]);
  }
  let head = `HTTP/1.1 ${this.statusCode} ${this.statusMessage}\r\n`;
  for (const key of Object.keys(this._headers)) {
    const v = this._headers[key];
    for (const one of Array.isArray(v) ? v : [v]) head += `${this._names[key] ?? key}: ${one}\r\n`;
  }
  this._header = `${head}\r\n`;
  this.headersSent = true;
  return this;
};
ServerResponse.prototype.flushHeaders = function () {
  if (!this.headersSent) this.writeHead(this.statusCode);
};
ServerResponse.prototype.write = function (chunk, encoding, callback) {
  if (!this.headersSent) this.writeHead(this.statusCode);
  return Writable.prototype.write.call(this, chunk, encoding, callback);
};
ServerResponse.prototype.end = function (chunk, encoding, callback) {
  if (typeof chunk === "function") {
    callback = chunk;
    chunk = undefined;
  }
  if (!this.headersSent) this.writeHead(this.statusCode);
  this.finished = true;
  return Writable.prototype.end.call(this, chunk, encoding, callback);
};
ServerResponse.prototype.setTimeout = function () {
  return this;
};
ServerResponse.prototype.writeContinue = function () {};
ServerResponse.prototype.writeProcessing = function () {};
ServerResponse.prototype.addTrailers = function () {};

export function createServer() {
  throw new Error("http.createServer: no server in a worker — Fastify takes a serverFactory");
}
export const Server = function Server() {};

export default { STATUS_CODES, METHODS, IncomingMessage, ServerResponse, createServer, Server };

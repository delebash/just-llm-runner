// SPDX-License-Identifier: MIT
// node:crypto for a worker, from Web Crypto: what the in-app server's routes use (random ids,
// random bytes). Node's full crypto polyfill is 3.8 MB of JavaScript for these few calls.
const web = globalThis.crypto;

export const webcrypto = web;
export const randomUUID = () => web.randomUUID();
export const getRandomValues = (array) => web.getRandomValues(array);

export function randomBytes(size, callback) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 65536) web.getRandomValues(bytes.subarray(i, Math.min(size, i + 65536)));
  if (typeof callback === "function") {
    queueMicrotask(() => callback(null, bytes));
    return undefined;
  }
  return bytes;
}

export function randomInt(min, max) {
  if (max === undefined) {
    max = min;
    min = 0;
  }
  const range = max - min;
  const [n] = web.getRandomValues(new Uint32Array(1));
  return min + (n % range);
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) throw new RangeError("Input buffers must have the same byte length");
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function createHash(algorithm) {
  throw new Error(`crypto.createHash(${algorithm}) isn't available in the in-app server`);
}

export default { webcrypto, randomUUID, getRandomValues, randomBytes, randomInt, timingSafeEqual, createHash };

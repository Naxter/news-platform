import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddress, assertPublicHttpUrl } from "../lib/collect/fetchGuard.mjs";

test("isPrivateAddress flags private and special IPv4 ranges", () => {
  const privates = [
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.24.10.10",
    "172.31.255.254",
    "192.168.0.1",
    "192.168.255.255",
    "127.0.0.1",
    "127.8.8.8",
    "169.254.0.10",
    "169.254.255.1",
    "100.64.0.1",
    "100.100.50.50",
    "100.127.255.255",
    "0.0.0.0",
    "255.255.255.255"
  ];
  for (const ip of privates) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateAddress passes public IPv4", () => {
  const publics = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "192.169.0.1",
    "169.253.0.1",
    "11.0.0.1",
    "126.255.255.255",
    "128.0.0.1"
  ];
  for (const ip of publics) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test("isPrivateAddress flags private IPv6 including v4-mapped", () => {
  const privates = [
    "::1",
    "::",
    "fe80::1",
    "fe80::abcd:1234%eth0",
    "febf::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "fdff:ffff::ffff",
    "::ffff:10.0.0.1",
    "::ffff:192.168.1.5",
    "::ffff:127.0.0.1",
    "::ffff:169.254.9.9",
    "::ffff:100.64.0.7",
    "[::1]"
  ];
  for (const ip of privates) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateAddress passes public IPv6", () => {
  const publics = [
    "2607:f8b0::1",
    "2001:4860:4860::8888",
    "2a00:1450:4001:80e::200e",
    "::ffff:8.8.8.8",
    "::ffff:93.184.216.34",
    "fbff::1",
    "fe00::1"
  ];
  for (const ip of publics) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test("isPrivateAddress returns false for non-IP input", () => {
  const nonIps = ["", "example.com", "localhost", "999.1.1.1", "10.0.0", "10.0.0.256", "not an ip", "zz::gg"];
  for (const value of nonIps) {
    assert.equal(isPrivateAddress(value), false, `${JSON.stringify(value)} should not be treated as private`);
  }
});

test("assertPublicHttpUrl rejects unsupported protocols", () => {
  const bad = [
    "ftp://example.com/feed.xml",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hello",
    "manual://notes"
  ];
  for (const url of bad) {
    assert.throws(() => assertPublicHttpUrl(url), /http/i, `${url} should be rejected`);
  }
});

test("assertPublicHttpUrl rejects localhost and literal private IPs", () => {
  const bad = [
    "http://localhost/feed",
    "http://localhost:8080/feed",
    "https://api.localhost/x",
    "http://127.0.0.1/feed",
    "http://10.1.2.3/rss",
    "http://192.168.1.10/rss",
    "http://172.20.0.5/rss",
    "http://169.254.1.1/rss",
    "http://100.64.3.4/rss",
    "http://[::1]/feed",
    "http://[fe80::1]/feed",
    "http://[fc00::1]/feed",
    "http://[::ffff:10.0.0.1]/feed",
    "http://0.0.0.0/feed"
  ];
  for (const url of bad) {
    assert.throws(() => assertPublicHttpUrl(url), Error, `${url} should be rejected`);
  }
});

test("assertPublicHttpUrl rejects garbage input", () => {
  for (const value of ["", "   ", "not a url", null, undefined]) {
    assert.throws(() => assertPublicHttpUrl(value), Error);
  }
});

test("assertPublicHttpUrl accepts public http(s) URLs and returns a URL", () => {
  const good = [
    "https://example.com/feed.xml",
    "http://news.example.org/rss?limit=20",
    "http://93.184.216.34/feed",
    "http://[2607:f8b0::1]/feed"
  ];
  for (const value of good) {
    const url = assertPublicHttpUrl(value);
    assert.ok(url instanceof URL, `${value} should return a URL instance`);
  }
});

test("assertPublicHttpUrl errors carry a 400 status", () => {
  try {
    assertPublicHttpUrl("http://127.0.0.1/");
    assert.fail("should have thrown");
  } catch (error) {
    assert.equal(error.status, 400);
  }
});

// Opening a locked check-out file (.calcheck) made by the desktop app's
// Check Out to Phones (phone_link.py has the same format, explained there).
// Nothing here touches the screen, so tests can run it in a browser on its own.
"use strict";

const CalCheck = (() => {
  const FORMAT = "calcheck";
  const VERSION = 1;
  const enc = new TextEncoder();

  function unb64(text) {
    const bin = atob(text);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function dataAad(header) {
    const names = header.inspectors.map(i => i.username).join(",");
    return enc.encode(`${FORMAT}|${VERSION}|${header.session}|${header.created}|${header.expires}|${names}`);
  }

  function keyAad(session, username) {
    return enc.encode(`${FORMAT}-key|${session}|${username}`);
  }

  // The outside of the file (readable without a PIN): who it's for, when it
  // expires. Throws for anything that isn't a check-out file this app reads.
  function readHeader(text) {
    let header;
    try { header = JSON.parse(text); } catch (e) { throw new Error("That isn't a check-out file."); }
    if (!header || header.format !== FORMAT) throw new Error("That isn't a check-out file.");
    if (header.version !== VERSION) throw new Error("This check-out file needs a newer version of the phone app. Reload the app while online.");
    if (!Array.isArray(header.inspectors) || !header.inspectors.length) throw new Error("The file is damaged.");
    return header;
  }

  function isExpired(header, now = new Date()) {
    return now >= new Date(header.expires);
  }

  async function pinKey(pin, salt, iterations) {
    const base = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations },
                                   base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  }

  // The tool data, or an Error ("Wrong PIN." etc.).
  async function open(header, username, pin) {
    const entry = header.inspectors.find(i => i.username === username);
    if (!entry) throw new Error("This file wasn't checked out to you.");
    const wrappingKey = await pinKey(pin, unb64(entry.salt), entry.iterations);
    let rawKey;
    try {
      rawKey = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(entry.iv), additionalData: keyAad(header.session, username) },
                                           wrappingKey, unb64(entry.key));
    } catch (e) {
      throw new Error("Wrong PIN.");
    }
    const dataKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    let plain;
    try {
      plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(header.iv), additionalData: dataAad(header) },
                                          dataKey, unb64(header.data));
    } catch (e) {
      throw new Error("The file has been changed or damaged. Ask for a new one.");
    }
    return JSON.parse(new TextDecoder().decode(plain));
  }

  return { readHeader, isExpired, open };
})();

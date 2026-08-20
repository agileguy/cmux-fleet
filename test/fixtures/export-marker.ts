/**
 * The marker the fake Pi stamps into an `export_html` document (ISC-234).
 *
 * Its own module for the same reason `scenario-steps.ts` is one: `fake-pi.ts`
 * parses argv and consumes stdin at import time, so a test that imported the
 * double to learn this string would start a second RPC loop. Two readers need
 * the same answer — the double that writes it and the test that looks for it —
 * and a literal copied into both is a literal that drifts the first time
 * either side is edited.
 *
 * WHY A MARKER AT ALL. `transcript --html` has two paths that agree on
 * everything a naive test can see: both exit 0, both report a written path,
 * and both leave a real HTML document there. They differ only in WHO rendered
 * it. Asserting the file exists would therefore pass with the live path
 * deleted — which is precisely the failure ISC-234 names. The marker is the
 * one observable that separates "Pi rendered this" from "the CLI re-rendered
 * A4 itself", so it is what the assertion has to hang on.
 *
 * The CLI's local renderer must never emit this string. It is checked in both
 * directions by the ISC-234 probe: present on the live path, absent on the
 * fallback.
 */
export const EXPORT_MARKER = "pi-export-html-marker";

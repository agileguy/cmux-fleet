/**
 * `parseSystemctlVerbs` and `parseJournalOptions` (`scripts/observe/characterise-vm`) produce 196 of
 * the 207 entries in `test/fixtures/observe/vm-forbidden-commands.json`: every forbidden `systemctl`
 * verb, every `journalctl` `Commands:` flag and every path-taking `journalctl` option came out of one
 * of these two functions reading a real `--help` page. The other 11 are forms §6.4 names that no help
 * page prints. Neither function had a unit test before this file — the fixture's
 * `>= 200` entry-count floor (`test/unit/observe-vm-forced-command.test.ts`) catches the fixture
 * collapsing to nothing, but not a partial loss on a re-measurement: a section quietly dropped, an
 * ANSI-wrapped verb missed, a path-taking option's placeholder misread.
 *
 * ## How the script is loaded
 *
 * `scripts/observe/characterise-vm` is TypeScript run by its `#!/usr/bin/env bun` shebang, with no `.ts`
 * extension, so nothing can `import` it by its real path. `characterise-vm-typecheck.test.ts` solves this
 * for `tsc` by copying the file into a temp directory as `characterise-vm.ts`; this file does the same and
 * then `import()`s that copy at runtime. The script's own `if (import.meta.main) await main();` guard
 * (already there — nothing here needed to change it) means importing it never calls `main`, so this file
 * never touches Docker, SSH, or any host.
 *
 * ## What's real and what's synthetic in the `--help` text below
 *
 * Every forbidden `systemctl` verb and every `journalctl` `Commands:` flag in the full pages below appears,
 * in the same section, in `test/fixtures/observe/vm-forbidden-commands.json`'s `source` field, which names
 * the systemd version and help-page section each measured entry came from; so do the `PATH`, `FILE` and
 * `ROOT` placeholders. The fixture records nothing else, so the allowed verbs, the non-path options and
 * their placeholders (`UNIT`, `RANGE`, …), the one-line descriptions and the ANSI codes are synthetic.
 * Neither parser reads a description. Where a case needs a shape the fixture never exercised, the test
 * says so at the point it's used.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = readFileSync(join(ROOT, "scripts", "observe", "characterise-vm"), "utf8");

interface Verb {
  verb: string;
  section: string;
}
interface JournalOption {
  flag: string;
  placeholder: string | null;
  section: string;
}
interface CharacteriseVmModule {
  parseSystemctlVerbs: (help: string) => Verb[];
  parseJournalOptions: (help: string) => JournalOption[];
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let parseSystemctlVerbs: CharacteriseVmModule["parseSystemctlVerbs"];
let parseJournalOptions: CharacteriseVmModule["parseJournalOptions"];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "characterise-vm-parse-"));
  dirs.push(dir);
  const file = join(dir, "characterise-vm.ts");
  writeFileSync(file, SCRIPT);
  const mod = (await import(pathToFileURL(file).href)) as CharacteriseVmModule;
  parseSystemctlVerbs = mod.parseSystemctlVerbs;
  parseJournalOptions = mod.parseJournalOptions;
});

/** ANSI SGR codes. `stripAnsi`'s docblock says newer systemd prints them in help headings even into a pipe; which code, and wrapping a verb or flag name in one, are synthetic here. */
const ESC = "\x1b";
const BOLD = `${ESC}[1m`;
const GREEN = `${ESC}[32m`;
const RESET = `${ESC}[0m`;

// ---------------------------------------------------------------------------------------------------------
// systemctl --help, systemd 239 shape (RHEL/Rocky 8 — SRD-OBSERVER-ROLES §6.4's oldest-in-scope systemd).
// Section names and every verb below appear as a `systemctl --help (systemd 239 (239-78.el8)), <Section>`
// source in vm-forbidden-commands.json. `list-units`, `show` and `is-system-running` (ALLOWED_SYSTEMCTL)
// are included deliberately: the parser does not filter them out — that's main()'s job, not this one's —
// so a correct parse still reports them, sectioned like everything else.
// ---------------------------------------------------------------------------------------------------------
const SYSTEMCTL_HELP_239 = `systemctl [OPTIONS...] {COMMAND} ...

Query or send control commands to the system manager.

Options:
  -h --help              Show this help
     --version           Show package version
     --system              Connect to system manager
     --user                 Connect to user service manager
  -t --type=TYPE           List units of a particular type
     --state=STATE         List units with particular LOAD or SUB or ACTIVE
                            state
     --failed               Shortcut for --state=failed

Unit Commands:
  list-units [PATTERN...]           List units currently in memory
  start UNIT...                     Start (activate) one or more units
  stop UNIT...                      Stop (deactivate) one or more units
  reload UNIT...                    Reload one or more units
  restart UNIT...                   Start or restart one or more units
  isolate UNIT                      Start one unit and stop all others
  kill UNIT...                      Send signal to processes of a unit
  is-active PATTERN...              Check whether units are active
  is-failed PATTERN...               Check whether units are failed
  status [PATTERN...|PID...]         Show runtime status of one or more
                                      units
  show [PATTERN...|JOB...]           Show properties of one or more
                                      units/jobs or the manager
  cat PATTERN...                     Show files and drop-ins of specified
                                      units
  help PATTERN...|PID...             Show manual for one or more units
  reset-failed [PATTERN...]          Reset failed state for all, one, or
                                      more units

Unit File Commands:
  list-unit-files [PATTERN...]      List installed unit files
  enable UNIT...                    Enable one or more unit files
  disable UNIT...                   Disable one or more unit files
  mask UNIT...                      Mask one or more units
  unmask UNIT...                    Unmask one or more units
  get-default                       Get the name of the default target
  set-default TARGET                Set the default target

Machine Commands:
  list-machines [PATTERN...]        List local containers and host

Job Commands:
  list-jobs [PATTERN...]            List jobs
  cancel [JOB...]                   Cancel all, one, or more jobs

Environment Commands:
  show-environment                  Dump environment
  set-environment VARIABLE=VALUE... Set one or more environment variables
  unset-environment VARIABLE...     Unset one or more environment variables
  import-environment [VARIABLE...]  Import all or some environment
                                     variables

Manager Lifecycle Commands:
  daemon-reload                     Reload systemd manager configuration
  daemon-reexec                     Reexecute systemd manager

System Commands:
  is-system-running                 Check whether system is fully running
  default                           Enter system default mode
  emergency                         Enter system emergency mode
  halt                              Shut down and halt the system
  poweroff                          Shut down and power-off the system
  reboot [ARG]                      Shut down and reboot the system
  hibernate                         Hibernate the system
  hybrid-sleep                      Hibernate and suspend the system

To show all installed unit files use 'systemctl list-unit-files'.
See 'man systemctl' for details.
`;

const SYSTEMCTL_HELP_239_VERBS: Verb[] = [
  { verb: "list-units", section: "Unit Commands" },
  { verb: "start", section: "Unit Commands" },
  { verb: "stop", section: "Unit Commands" },
  { verb: "reload", section: "Unit Commands" },
  { verb: "restart", section: "Unit Commands" },
  { verb: "isolate", section: "Unit Commands" },
  { verb: "kill", section: "Unit Commands" },
  { verb: "is-active", section: "Unit Commands" },
  { verb: "is-failed", section: "Unit Commands" },
  { verb: "status", section: "Unit Commands" },
  { verb: "show", section: "Unit Commands" },
  { verb: "cat", section: "Unit Commands" },
  { verb: "help", section: "Unit Commands" },
  { verb: "reset-failed", section: "Unit Commands" },
  { verb: "list-unit-files", section: "Unit File Commands" },
  { verb: "enable", section: "Unit File Commands" },
  { verb: "disable", section: "Unit File Commands" },
  { verb: "mask", section: "Unit File Commands" },
  { verb: "unmask", section: "Unit File Commands" },
  { verb: "get-default", section: "Unit File Commands" },
  { verb: "set-default", section: "Unit File Commands" },
  { verb: "list-machines", section: "Machine Commands" },
  { verb: "list-jobs", section: "Job Commands" },
  { verb: "cancel", section: "Job Commands" },
  { verb: "show-environment", section: "Environment Commands" },
  { verb: "set-environment", section: "Environment Commands" },
  { verb: "unset-environment", section: "Environment Commands" },
  { verb: "import-environment", section: "Environment Commands" },
  { verb: "daemon-reload", section: "Manager Lifecycle Commands" },
  { verb: "daemon-reexec", section: "Manager Lifecycle Commands" },
  { verb: "is-system-running", section: "System Commands" },
  { verb: "default", section: "System Commands" },
  { verb: "emergency", section: "System Commands" },
  { verb: "halt", section: "System Commands" },
  { verb: "poweroff", section: "System Commands" },
  { verb: "reboot", section: "System Commands" },
  { verb: "hibernate", section: "System Commands" },
  { verb: "hybrid-sleep", section: "System Commands" },
];

// ---------------------------------------------------------------------------------------------------------
// systemctl --help, systemd 255 shape (the fixture's other measured host). Headings and some verb names are
// wrapped in ANSI codes (synthetic: see ESC above). `Manager State Commands` and the verbs `bind`, `clean`,
// `mount-image`, `service-log-level`, `soft-reboot` are 255-only, per vm-forbidden-commands.json's sources
// for that host.
// ---------------------------------------------------------------------------------------------------------
const SYSTEMCTL_HELP_255_ANSI = `${BOLD}systemctl${RESET} [OPTIONS...] {COMMAND} ...

Query or send control commands to the system manager.

Options:
  -h --help              Show this help
     --version           Show package version
     --type=TYPE          List units of a particular type

${BOLD}Unit Commands:${RESET}
  ${BOLD}list-units${RESET} [PATTERN...]           List units currently in memory
  start UNIT...                     Start (activate) one or more units
  stop UNIT...                      Stop (deactivate) one or more units
  bind UNIT PATH [PATH]              Bind mount a path from the host into a
                                      unit's mount namespace
  clean UNIT...                      Clean runtime, cache, state, logs or
                                      configuration of unit
  mount-image UNIT IMAGE [PATH]      Mount an image to the target directory
                                      of a unit
  service-log-level SERVICE [LEVEL]  Get/set logging threshold for service
  show [PATTERN...|JOB...]           Show properties of one or more
                                      units/jobs or the manager

Manager State Commands:
  log-level [LEVEL]                  Get/set logging threshold for manager
  log-target [TARGET]                Get/set logging target for manager
  service-watchdogs [BOOL]           Get/set service watchdog state

${BOLD}System Commands:${RESET}
  is-system-running                  Check whether system is fully running
  default                            Enter system default mode
  ${BOLD}soft-reboot${RESET}                        Shut down and reboot userspace
  halt                                Shut down and halt the system
  poweroff                            Shut down and power-off the system
  reboot [ARG]                        Shut down and reboot the system
`;

const SYSTEMCTL_HELP_255_ANSI_VERBS: Verb[] = [
  { verb: "list-units", section: "Unit Commands" },
  { verb: "start", section: "Unit Commands" },
  { verb: "stop", section: "Unit Commands" },
  { verb: "bind", section: "Unit Commands" },
  { verb: "clean", section: "Unit Commands" },
  { verb: "mount-image", section: "Unit Commands" },
  { verb: "service-log-level", section: "Unit Commands" },
  { verb: "show", section: "Unit Commands" },
  { verb: "log-level", section: "Manager State Commands" },
  { verb: "log-target", section: "Manager State Commands" },
  { verb: "service-watchdogs", section: "Manager State Commands" },
  { verb: "is-system-running", section: "System Commands" },
  { verb: "default", section: "System Commands" },
  { verb: "soft-reboot", section: "System Commands" },
  { verb: "halt", section: "System Commands" },
  { verb: "poweroff", section: "System Commands" },
  { verb: "reboot", section: "System Commands" },
];

// ---------------------------------------------------------------------------------------------------------
// journalctl --help, systemd 239 shape: everything but the `Commands:` heading files under one `Options:`
// heading (`parseJournalOptions`' docblock describes 239's layout). The path-taking options below
// (`--directory`, `--file` -> PATH; `--root` -> ROOT) and every `Commands:` flag are exactly what
// vm-forbidden-commands.json's `journalctl --help (systemd 239 (239-78.el8)), …` sources name.
// ---------------------------------------------------------------------------------------------------------
const JOURNALCTL_HELP_239 = `journalctl [OPTIONS...] [MATCHES...]

Query the journal.

Options:
     --no-pager             Do not pipe output into a pager
  -a --all                  Show all fields, including long and unprintable
  -f --follow               Follow the journal
  -n --lines[=INTEGER]      Number of journal entries to show
  -r --reverse               Show the newest entries first
  -o --output=STRING        Change journal output mode
  -u --unit=UNIT             Show logs from the specified unit
  -p --priority=RANGE        Show entries with the specified priority
     --since=DATE            Show entries not older than the specified date
     --until=DATE            Show entries not newer than the specified date
  -D --directory=PATH        Show journal files from the specified
                              directory
     --file=PATH             Operate on the specified journal files
     --root=ROOT             Operate on catalog file hierarchy under the
                              specified root path
  -q --quiet                 Do not show info messages and privilege
                              warnings

Commands:
  -h --help                  Show this help text
     --version                Show package version
     --new-id128               Generate a new 128-bit ID
     --disk-usage               Show total disk usage of all journal files
     --list-catalog              Show message IDs of all entries in the
                                  message catalog
     --dump-catalog              Show entries in the message catalog
     --setup-keys                 Generate a new FSS key pair
     --update-catalog             Update the message catalog database
     --sync                       Synchronize unwritten journal messages to
                                  disk
     --relinquish-var             Stop logging to disk, log to /run instead
     --smart-relinquish-var       Similar, but NOP if /var is on the same
                                  file system as the runtime journal
     --flush                      Flush all journal data from /run into
                                  /var
     --rotate                     Request immediate rotation of the
                                  journal files
     --vacuum-size=BYTES           Reduce disk usage below specified size
     --vacuum-files=INT            Leave only the specified number of
                                  journal files
     --vacuum-time=TIME            Remove journal files older than
                                  specified time
     --verify                     Verify journal file consistency
     --header                     Show journal header information
     --field=FIELD                 List all values a certain field takes
     --fields                      List all field names currently used
`;

const JOURNALCTL_HELP_239_OPTIONS: JournalOption[] = [
  { flag: "--no-pager", placeholder: null, section: "Options" },
  { flag: "--all", placeholder: null, section: "Options" },
  { flag: "--follow", placeholder: null, section: "Options" },
  { flag: "--lines", placeholder: "INTEGER", section: "Options" },
  { flag: "--reverse", placeholder: null, section: "Options" },
  { flag: "--output", placeholder: "STRING", section: "Options" },
  { flag: "--unit", placeholder: "UNIT", section: "Options" },
  { flag: "--priority", placeholder: "RANGE", section: "Options" },
  { flag: "--since", placeholder: "DATE", section: "Options" },
  { flag: "--until", placeholder: "DATE", section: "Options" },
  { flag: "--directory", placeholder: "PATH", section: "Options" },
  { flag: "--file", placeholder: "PATH", section: "Options" },
  { flag: "--root", placeholder: "ROOT", section: "Options" },
  { flag: "--quiet", placeholder: null, section: "Options" },
  { flag: "--help", placeholder: null, section: "Commands" },
  { flag: "--version", placeholder: null, section: "Commands" },
  { flag: "--new-id128", placeholder: null, section: "Commands" },
  { flag: "--disk-usage", placeholder: null, section: "Commands" },
  { flag: "--list-catalog", placeholder: null, section: "Commands" },
  { flag: "--dump-catalog", placeholder: null, section: "Commands" },
  { flag: "--setup-keys", placeholder: null, section: "Commands" },
  { flag: "--update-catalog", placeholder: null, section: "Commands" },
  { flag: "--sync", placeholder: null, section: "Commands" },
  { flag: "--relinquish-var", placeholder: null, section: "Commands" },
  { flag: "--smart-relinquish-var", placeholder: null, section: "Commands" },
  { flag: "--flush", placeholder: null, section: "Commands" },
  { flag: "--rotate", placeholder: null, section: "Commands" },
  { flag: "--vacuum-size", placeholder: "BYTES", section: "Commands" },
  { flag: "--vacuum-files", placeholder: "INT", section: "Commands" },
  { flag: "--vacuum-time", placeholder: "TIME", section: "Commands" },
  { flag: "--verify", placeholder: null, section: "Commands" },
  { flag: "--header", placeholder: null, section: "Commands" },
  { flag: "--field", placeholder: "FIELD", section: "Commands" },
  { flag: "--fields", placeholder: null, section: "Commands" },
];

// ---------------------------------------------------------------------------------------------------------
// journalctl --help, systemd 255 shape: split into several headings instead of one `Options:`
// (`parseJournalOptions`' docblock describes 255's layout). `--list-boots` (Commands), `--cursor-file=FILE`
// (Filtering Options) and `--image`/`--root` under Source Options — both spelled with a PATH placeholder on
// this version, per vm-forbidden-commands.json's `Source Options, reads PATH` source for both — are exactly
// what that fixture's 255 sources name. The `Output Options` block is synthetic: the fixture records nothing
// from it, and it is here to show a heading with nothing forbidden in it still parses and sections correctly.
// ---------------------------------------------------------------------------------------------------------
const JOURNALCTL_HELP_255_ANSI = `${BOLD}journalctl${RESET} [OPTIONS...] [MATCHES...]

Query the journal.

${BOLD}Commands:${RESET}
  -h --help                    Show this help text
     --version                  Show package version
     --list-boots                Show terse information about recorded
                                  boots

Filtering Options:
  -u --unit=UNIT                Show logs from the specified unit
     --user-unit=UNIT            Show logs from the specified user unit
     --cursor-file=FILE          Show entries after the cursor stored in
                                  the specified file
  -p --priority=RANGE            Show entries with the specified priority

${BOLD}Source Options:${RESET}
     --directory=PATH            Operate on the specified journal
                                  directory
     --file=PATH                 Operate on the specified journal files
     ${BOLD}--root=PATH${RESET}                 Operate on catalog file hierarchy under
                                  the specified root path
     --image=PATH                Operate on the specified disk image or
                                  container

Output Options:
  -o --output=STRING             Change journal output mode
     --output-fields=LIST        Select fields to print
     --utc                       Express time in Coordinated Universal
                                  Time
`;

const JOURNALCTL_HELP_255_ANSI_OPTIONS: JournalOption[] = [
  { flag: "--help", placeholder: null, section: "Commands" },
  { flag: "--version", placeholder: null, section: "Commands" },
  { flag: "--list-boots", placeholder: null, section: "Commands" },
  { flag: "--unit", placeholder: "UNIT", section: "Filtering Options" },
  { flag: "--user-unit", placeholder: "UNIT", section: "Filtering Options" },
  { flag: "--cursor-file", placeholder: "FILE", section: "Filtering Options" },
  { flag: "--priority", placeholder: "RANGE", section: "Filtering Options" },
  { flag: "--directory", placeholder: "PATH", section: "Source Options" },
  { flag: "--file", placeholder: "PATH", section: "Source Options" },
  { flag: "--root", placeholder: "PATH", section: "Source Options" },
  { flag: "--image", placeholder: "PATH", section: "Source Options" },
  { flag: "--output", placeholder: "STRING", section: "Output Options" },
  { flag: "--output-fields", placeholder: "LIST", section: "Output Options" },
  { flag: "--utc", placeholder: null, section: "Output Options" },
];

describe("parseSystemctlVerbs", () => {
  test("extracts every verb from a systemd-239-shaped --help page, correctly sectioned and in encountered order", () => {
    expect(parseSystemctlVerbs(SYSTEMCTL_HELP_239)).toEqual(SYSTEMCTL_HELP_239_VERBS);
  });

  test("extracts every verb from a systemd-255-shaped --help page, ANSI headings and verb names included", () => {
    expect(parseSystemctlVerbs(SYSTEMCTL_HELP_255_ANSI)).toEqual(SYSTEMCTL_HELP_255_ANSI_VERBS);
  });

  test("does not drop a verb from the middle of a section", () => {
    // Every one of the five verbs below must round-trip — a parser that skipped, say, every second
    // entry would lose "bravo" and "delta" and this would go red.
    const help = `Foo Commands:
  alpha                 do alpha things
  bravo                 do bravo things
  charlie               do charlie things
  delta                 do delta things
  echo                  do echo things
`;
    expect(parseSystemctlVerbs(help)).toEqual([
      { verb: "alpha", section: "Foo Commands" },
      { verb: "bravo", section: "Foo Commands" },
      { verb: "charlie", section: "Foo Commands" },
      { verb: "delta", section: "Foo Commands" },
      { verb: "echo", section: "Foo Commands" },
    ]);
  });

  test("stops collecting verbs at a heading that is not itself a '*Commands:' section, and resumes at the next one that is", () => {
    // "Global options:" does not end in "Commands:", so it must not open a new verb-collecting section,
    // and with no blank line above it, it alone must end the "Commands:" section. "bravo" below it is
    // shaped exactly like a real verb line (2-space indent, lowercase) and must still be excluded.
    const help = `Commands:
  alpha                do alpha
Global options:
  bravo                 not a verb, looks like one but isn't

More Commands:
  charlie              do charlie
`;
    expect(parseSystemctlVerbs(help)).toEqual([
      { verb: "alpha", section: "Commands" },
      { verb: "charlie", section: "More Commands" },
    ]);
  });

  test("does not pick up option lines or wrapped description continuations as verbs", () => {
    // "-x --flag" and "--long-flag=VALUE" start with a dash, not a lowercase letter. The two wrapped
    // continuation lines are indented well past the 2-space verb column, exactly as real systemctl --help
    // wraps a long description — neither shape is a verb.
    const help = `Some Commands:
  alpha                 Do the alpha thing, an operation whose description
                         wraps onto a continuation line indented past the
                         verb column
  -x --flag              Not a verb: begins with a dash
     --long-flag=VALUE   Not a verb: begins with a dash after more spaces
  bravo                  Do the bravo thing
`;
    expect(parseSystemctlVerbs(help)).toEqual([
      { verb: "alpha", section: "Some Commands" },
      { verb: "bravo", section: "Some Commands" },
    ]);
  });

  test("ANSI-wrapped verb names are parsed once the escapes are stripped (minimal, isolated case)", () => {
    const help = `${BOLD}Unit Commands:${RESET}
  ${GREEN}list-units${RESET} [PATTERN...]   List units currently in memory
  ${GREEN}show${RESET} [PATTERN...|JOB...]  Show properties of a unit
`;
    expect(parseSystemctlVerbs(help)).toEqual([
      { verb: "list-units", section: "Unit Commands" },
      { verb: "show", section: "Unit Commands" },
    ]);
  });
});

describe("parseJournalOptions", () => {
  test("extracts every option from a systemd-239-shaped --help page: one 'Options:' heading plus a separate 'Commands:' heading, placeholders included", () => {
    expect(parseJournalOptions(JOURNALCTL_HELP_239)).toEqual(JOURNALCTL_HELP_239_OPTIONS);
  });

  test("extracts every option from a systemd-255-shaped --help page: 'Commands:' plus the split 'Filtering Options:' / 'Source Options:' / 'Output Options:' headings, ANSI included", () => {
    expect(parseJournalOptions(JOURNALCTL_HELP_255_ANSI)).toEqual(JOURNALCTL_HELP_255_ANSI_OPTIONS);
  });

  test("does not drop an option from the middle of a section", () => {
    // Seven options, placeholders on three of them — a parser that skipped alternating entries would lose
    // "--version", "--field" and "--vacuum-time".
    const help = `Commands:
  -h --help                Show this help text
     --version              Show package version
     --new-id128            Generate a new 128-bit ID
     --field=FIELD           List all values a certain field takes
     --disk-usage            Show total disk usage of all journal files
     --vacuum-time=TIME      Remove journal files older than specified time
     --flush                 Flush all journal data from /run into /var
`;
    expect(parseJournalOptions(help)).toEqual([
      { flag: "--help", placeholder: null, section: "Commands" },
      { flag: "--version", placeholder: null, section: "Commands" },
      { flag: "--new-id128", placeholder: null, section: "Commands" },
      { flag: "--field", placeholder: "FIELD", section: "Commands" },
      { flag: "--disk-usage", placeholder: null, section: "Commands" },
      { flag: "--vacuum-time", placeholder: "TIME", section: "Commands" },
      { flag: "--flush", placeholder: null, section: "Commands" },
    ]);
  });

  test("a new heading ends the section before it: entries before any heading are excluded, and entries after a new heading are attributed to it, not the one before", () => {
    // "-a --all" appears before any heading at all and must be excluded (unlike parseSystemctlVerbs,
    // parseJournalOptions has no blank-line reset — only a fresh heading changes the current section, so
    // this also proves a heading does the work a blank line does for the other parser).
    const help = `journalctl [OPTIONS...] [MATCHES...]

Query the journal.

  -a --all                 Not yet under any heading, must be excluded

Commands:
  --disk-usage             Show total disk usage of all journal files
  --flush                  Flush all journal data from /run into /var

Filtering Options:
  -u --unit=UNIT           Show logs from the specified unit
  -p --priority=RANGE      Show entries with the specified priority
`;
    expect(parseJournalOptions(help)).toEqual([
      { flag: "--disk-usage", placeholder: null, section: "Commands" },
      { flag: "--flush", placeholder: null, section: "Commands" },
      { flag: "--unit", placeholder: "UNIT", section: "Filtering Options" },
      { flag: "--priority", placeholder: "RANGE", section: "Filtering Options" },
    ]);
  });

  test("does not pick up a short-option-only line, a prose line that merely mentions a flag, or a wrapped continuation with no option marker", () => {
    // "-a" alone has no "--long" spelling, so the entry regex (which requires the "--" form) never matches
    // it. The "See --unit=UNIT ..." line does contain a "--" flag, but not at the start of the line (real
    // option lines always are), so it must not be picked up either. The two unmarked continuation lines
    // carry no "--" token at all.
    const help = `Options:
  -a                        Short option alone, no long form, must not be
                             picked up
                             journal directory to operate on relative to the
                             root filesystem, wrapped continuation with no
                             leading option marker
See --unit=UNIT in the main text, embedded in prose, must not be picked up
  -u --unit=UNIT             Show logs from the specified unit
`;
    expect(parseJournalOptions(help)).toEqual([{ flag: "--unit", placeholder: "UNIT", section: "Options" }]);
  });

  test("recognises every placeholder PATH_PLACEHOLDERS treats as a path: PATH, FILE, DIR, ROOT, IMAGE", () => {
    // PATH, FILE and ROOT are measured (vm-forbidden-commands.json's `reads PATH`/`reads FILE`/`reads ROOT`
    // sources). DIR and IMAGE are not: no help page measured for this SRD printed either, and both flag
    // spellings here are synthetic (255's `--image` takes PATH). The script's PATH_PLACEHOLDERS lists all
    // five, so the parser must recognise the shape generically rather than only the placeholders observed.
    const help = `Source Options:
     --directory=PATH        Operate on the specified journal directory
     --file=PATH             Operate on the specified journal files
     --root=ROOT              Operate on catalog file hierarchy under the
                              specified root path
     --image=IMAGE            Operate on the specified disk image
     --work-directory=DIR     Use the specified scratch directory
`;
    expect(parseJournalOptions(help)).toEqual([
      { flag: "--directory", placeholder: "PATH", section: "Source Options" },
      { flag: "--file", placeholder: "PATH", section: "Source Options" },
      { flag: "--root", placeholder: "ROOT", section: "Source Options" },
      { flag: "--image", placeholder: "IMAGE", section: "Source Options" },
      { flag: "--work-directory", placeholder: "DIR", section: "Source Options" },
    ]);
  });

  test("ANSI-wrapped option names are parsed once the escapes are stripped (minimal, isolated case)", () => {
    const help = `${BOLD}Commands:${RESET}
  ${GREEN}--disk-usage${RESET}              Show total disk usage of all
                                  journal files
`;
    expect(parseJournalOptions(help)).toEqual([{ flag: "--disk-usage", placeholder: null, section: "Commands" }]);
  });
});

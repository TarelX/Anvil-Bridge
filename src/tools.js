"use strict";
var describe = (t, e) => (e ? { ...t, description: e } : t),
  str = (t = 512, e) => describe({ type: "string", minLength: 1, maxLength: t }, e),
  int = (t, e, r) => describe({ type: "integer", minimum: t, maximum: e }, r),
  bool = (t) => describe({ type: "boolean" }, t),
  enumOf = (t, e) => describe({ type: "string", enum: t }, e),
  arr = (t, e = 20, r) => describe({ type: "array", items: t, maxItems: e }, r),
  obj = (t, e = []) => ({ type: "object", properties: t, required: e, additionalProperties: !1 }),
  tools = [],
  tool = (t, e, r) => tools.push({ name: t, description: e, inputSchema: r });
tool(
  "list_directory",
  "List the immediate contents of one workspace directory (depth 1 or 2). Use this to understand a directory you already know; use find_files to search by name/path pattern and search_files to search contents. Hidden and generated directories are excluded unless requested; secret paths and symlinks are always refused. If truncated=true, list a narrower path instead of raising max_entries.",
  obj({
    path: str(512, "Workspace-relative directory path. Defaults to the workspace root '.'."),
    depth: int(1, 2, "Directory levels to list. Defaults to 1. Use find_files for recursive discovery."),
    include_hidden: bool("Include dot-prefixed entries. Defaults to false."),
    no_ignore: bool(
      "Include commonly generated directories such as node_modules, dist, build and coverage. Defaults to false.",
    ),
    max_entries: int(1, 300, "Maximum entries returned. Defaults to 150; hard maximum 300."),
  }),
);
tool(
  "find_files",
  "Find files by path/name glob pattern; this does NOT search file contents (use search_files for that). Use it when you know a filename, extension or path shape but not the exact path. Batch independent patterns into one call instead of calling repeatedly. Only *, ** and ? are supported - no braces, no negation. Results are files only, never directories, and are bounded to 8000 visited entries and 300 returned paths. If truncated=true, narrow path/patterns before raising max_results.",
  obj(
    {
      patterns: arr(
        str(512, "A glob pattern such as '**/*.ts' or 'src/**/server.js'."),
        20,
        "One or more glob patterns evaluated in a single call, relative to path.",
      ),
      path: str(512, "Directory scope relative to the workspace root. Defaults to '.'."),
      exclude: arr(
        str(512, "A glob pattern to exclude."),
        20,
        'Glob patterns removed from the result, e.g. ["**/*.min.js"].',
      ),
      case_sensitive: bool("Make glob matching case-sensitive. Defaults to false (case-insensitive)."),
      include_hidden: bool("Include hidden files and directories. Defaults to false."),
      no_ignore: bool(
        "Include commonly generated directories such as node_modules and dist. Defaults to false.",
      ),
      sort: enumOf(
        ["path_asc", "modified_desc"],
        "Result order. Defaults to 'path_asc' (deterministic lexical); 'modified_desc' puts recently modified files first.",
      ),
      max_results: int(1, 300, "Maximum paths returned. Defaults to 100; hard maximum 300."),
    },
    ["patterns"],
  ),
);
tool(
  "read_files",
  "Read bounded UTF-8 file contents from disk and return a SHA-256 version per file, which apply_patch accepts in expected_versions to guard against editing a file that changed after it was read. Batch independent files into one call. The default window is 200 lines; pass end_line for up to 1000 lines per file per call, or whole_file:true to read a file that fits that cap in one go. For large files prefer lsp document_symbols first, then read only the ranges you need. A shared 100k-character budget per call may truncate further - check has_more, next_start_line and next_step. Binary files, oversized files and secret paths are refused. Unsaved editor changes are NOT included.",
  obj(
    {
      files: arr(
        obj(
          {
            path: str(512, "File path relative to the workspace root."),
            start_line: int(1, 1e6, "Optional 1-based inclusive first line. Defaults to 1."),
            end_line: int(
              1,
              1e6,
              "Optional 1-based inclusive last line. Defaults to start_line + 199; at most start_line + 999 is honoured.",
            ),
            whole_file: bool(
              "Read from start_line to the end of the file (still capped at 1000 lines per call). Overrides end_line.",
            ),
          },
          ["path"],
        ),
        20,
        "Files to read in one call. Request independent files together.",
      ),
    },
    ["files"],
  ),
);
tool(
  "search_files",
  "Search file contents and return bounded path/line/snippet matches. Use this to locate code before read_files; use find_files for filenames and lsp for symbols. Literal search is the default; set is_regex=true only when regular-expression semantics are required. Omit case_sensitive for smart-case (a lowercase pattern is case-insensitive; any uppercase character makes it case-sensitive). Narrow with path and include/exclude globs to save budget. context_lines returns neighbouring lines for disambiguation - keep it small, this tool locates code rather than reading files. If truncated=true, narrow the query instead of raising limits.",
  obj(
    {
      pattern: str(500, "Text to find, or a regular expression when is_regex=true."),
      path: str(512, "File or directory scope relative to the workspace root. Defaults to '.'."),
      is_regex: bool(
        "Interpret pattern as a JavaScript regular expression. Defaults to false (literal text).",
      ),
      case_sensitive: bool("true = case-sensitive, false = case-insensitive, omitted = smart-case."),
      include: arr(
        str(512, "A glob pattern of files to search."),
        20,
        'Only search files matching these globs, e.g. ["**/*.ts"].',
      ),
      exclude: arr(
        str(512, "A glob pattern of files to skip."),
        20,
        'Skip files matching these globs, e.g. ["**/*.test.ts"].',
      ),
      context_lines: int(
        0,
        5,
        "Lines of context returned on each side of a match. Defaults to 1; maximum 5. Pass 0 to disable context.",
      ),
      max_matches_per_file: int(
        1,
        100,
        "Maximum matches returned from a single file so one file cannot consume the whole budget. Defaults to 20.",
      ),
      include_hidden: bool("Include hidden files and directories. Defaults to false."),
      no_ignore: bool(
        "Include commonly generated directories such as node_modules and dist. Defaults to false.",
      ),
      max_results: int(
        1,
        300,
        "Maximum matches returned across the whole call. Defaults to 100; hard maximum 300.",
      ),
    },
    ["pattern"],
  ),
);
tool(
  "apply_patch",
  "Add, Update, Move or Delete workspace files with a Codex-style patch. Prefer one call containing all related edits over many small ones. The envelope is '*** Begin Patch' ... '*** End Patch' with '*** Add File: path', '*** Update File: path' or '*** Delete File: path' directives. Add bodies are all '+' lines. Update bodies are hunks starting with '@@', using a leading space for context, '-' for removed and '+' for added lines; each hunk's context must match exactly, uniquely and in file order or the whole patch is refused without partial application - re-read the file and regenerate. An optional '*** Move to: path' line may immediately follow '*** Update File: path' to rename or relocate that file; the destination must not already exist and must not be targeted twice in one patch, and hunks are optional, so Update plus Move with no hunks is a pure rename. When read_files has returned versions for the files you are modifying, pass them in expected_versions keyed by file path; a mismatch returns STALE_FILE instead of editing a file that changed after it was read. Files open with unsaved editor changes are refused. Locally approved by default; approval is skipped only when the local user enables full access. Preflight plus rollback on caught write failures, but this is not a multi-file filesystem transaction.",
  obj(
    {
      patch: str(
        524288,
        "Full patch text beginning with '*** Begin Patch' and ending with '*** End Patch'. At most 30 files.",
      ),
      expected_versions: describe(
        {
          type: "object",
          additionalProperties: str(80, "A 'sha256:...' version string returned by read_files."),
          maxProperties: 50,
        },
        "Optional map of file path to the sha256 version last returned by read_files. Strongly recommended whenever those versions are available; a mismatch returns STALE_FILE instead of editing a file that changed after it was read.",
      ),
    },
    ["patch"],
  ),
);
tool(
  "run_command",
  'Run a shell command. execution="pty" (default) uses a persistent managed terminal that keeps cwd, environment and shell functions between calls and supports interactive input; execution="direct" runs an isolated one-shot process with piped output. The interpreter is host-dependent (see the "Host shell" note in the server instructions); every result carries shell and shell_hint - on Windows PowerShell 5.1 use ";" not "&&" and read $LASTEXITCODE. Omitting terminal_id reuses an idle foreground PTY owned by this session; background=true gets a dedicated new PTY. Omit cwd to keep the shell current directory; passing cwd resets it. Always choose background explicitly: true for servers and watchers, false for commands whose result you await. running:true means poll get_command_output or send input - do not relaunch the command. If execution is omitted and this platform has no PTY backend (e.g. Linux), it runs as direct; the result execution field shows which mode ran.',
  obj(
    {
      command: str(8e3, "Shell command line to execute."),
      cwd: str(
        512,
        "Workspace-relative working directory. Omit to continue from the terminal current directory.",
      ),
      background: bool(
        "true when the command is expected to keep running, false when its result should be awaited. Must be chosen explicitly.",
      ),
      execution: enumOf(
        ["pty", "direct"],
        "'pty' = persistent visible terminal, interactive; 'direct' = isolated one-shot process with a process-level exit code. Defaults to 'pty'.",
      ),
      terminal_id: str(
        80,
        "Reuse a specific terminal from list_terminals instead of an automatically chosen idle one.",
      ),
      timeout_ms: int(
        1e3,
        36e5,
        "For foreground commands, how long to wait before returning status=running. The command is NOT killed on timeout.",
      ),
      wait_ms: int(0, 25e3, "Extra settle time to collect output before returning."),
      cols: int(20, 500, "Initial terminal width in columns."),
      rows: int(5, 200, "Initial terminal height in rows."),
      show: bool("Reveal the terminal in the VS Code UI. Defaults to false."),
    },
    ["command", "background"],
  ),
);
tool(
  "get_command_output",
  "Read new output and status for a command you started with run_command. Pass the previous next_offset so old output is not repeated. In PTY mode the output contains terminal escape sequences. Offsets count UTF-16 characters, not bytes. running and cleanup_pending describe different states: running means the command is still active, cleanup_pending means it finished but its terminal is still being reclaimed.",
  obj(
    {
      command_id: str(80, "The command_id returned by run_command."),
      offset: int(
        0,
        1e8,
        "UTF-16 character offset to start reading from. Use the previous next_offset. Defaults to 0.",
      ),
      max_chars: int(1, 32e3, "Maximum characters returned in this read. Defaults to 8000."),
    },
    ["command_id"],
  ),
);
tool(
  "send_command_input",
  "Send input to an active command you own, for interactive prompts and REPLs. append_newline defaults to true and sends CR in PTY mode. For arrow keys or control characters send the raw sequence with append_newline:false; Ctrl+C requests interruption with a terminal-recycle fallback. Approval mode prompts the local user; full access does not.",
  obj(
    {
      command_id: str(80, "The command_id returned by run_command."),
      input: describe({ type: "string", maxLength: 8e3 }, "Text or raw control sequence to send."),
      append_newline: bool(
        "Append Enter after the input. Defaults to true; set false for control characters.",
      ),
    },
    ["command_id", "input"],
  ),
);
tool(
  "stop_command",
  "Stop a command you own. In PTY mode this sends Ctrl+C first and closes the terminal if no completion marker arrives within 1.5 seconds; force:true closes the terminal immediately. Direct mode requests process-tree termination. Exit may remain unconfirmed - poll get_command_output for final status.",
  obj(
    {
      command_id: str(80, "The command_id returned by run_command."),
      force: bool("Skip the graceful interrupt and close the terminal immediately. Defaults to false."),
    },
    ["command_id"],
  ),
);
tool(
  "list_terminals",
  "List the persistent PTYs owned by this session with their dimensions, current directory and active command. Use it before reusing a terminal_id in run_command. Terminals belonging to other sessions or to the local user are never exposed.",
  obj({}),
);
tool(
  "resize_terminal",
  "Resize a PTY you own and signal its foreground application, which matters for TUIs and for commands whose output wraps. This does not start a command.",
  obj(
    {
      terminal_id: str(80, "A terminal_id from list_terminals."),
      cols: int(20, 500, "New width in columns."),
      rows: int(5, 200, "New height in rows."),
    },
    ["terminal_id", "cols", "rows"],
  ),
);
tool(
  "close_terminal",
  "Close a PTY you own, terminating its active command and discarding its shell state such as environment variables and current directory. Process-tree cleanup is best effort.",
  obj({ terminal_id: str(80, "A terminal_id from list_terminals.") }),
);
tool(
  "get_diagnostics",
  "Read diagnostics that VS Code and its language services have already produced. This does NOT run a build, a linter or any command - run those with run_command first if fresh results are needed. Use it after edits to inspect errors structurally instead of parsing compiler output. Filter with severity when only errors matter, so warnings and hints do not consume the result budget.",
  obj({
    path: str(512, "Workspace-relative file or directory scope. Defaults to the whole workspace."),
    severity: arr(
      enumOf(["error", "warning", "information", "hint"], "A severity level to include."),
      4,
      "Severity levels to return. Defaults to all severities.",
    ),
    max_results: int(1, 200, "Maximum diagnostics returned. Defaults to 100; hard maximum 200."),
  }),
);
tool(
  "lsp",
  "Navigate code semantically through the language providers already active in VS Code. Prefer this over search_files for symbols, definitions, references, implementations and type information; use search_files for raw text and read_files once lsp has located the code. path/line/column are 1-based and required for definition, type_definition, references, implementation, hover, incoming_calls and outgoing_calls; query is required for workspace_symbols. Use incoming_calls before changing a function signature - it returns the callers a text search cannot reliably find - and outgoing_calls to see what a function depends on. Locations outside the selected workspace root are filtered out. An empty result is INCONCLUSIVE - the language server may simply not be warmed up yet - so do not conclude a symbol does not exist.",
  obj(
    {
      operation: enumOf(
        [
          "document_symbols",
          "workspace_symbols",
          "definition",
          "type_definition",
          "references",
          "implementation",
          "hover",
          "incoming_calls",
          "outgoing_calls",
        ],
        "Semantic operation to run through VS Code language feature providers. incoming_calls/outgoing_calls expand the call hierarchy at the given position.",
      ),
      path: str(
        512,
        "Workspace-relative source file. Required for every operation except workspace_symbols, where it may be given as an anchor to activate the right language project.",
      ),
      query: str(200, "Symbol name to look up. Required for workspace_symbols."),
      line: int(
        1,
        1e6,
        "1-based source line. Required for position-based operations including incoming_calls and outgoing_calls.",
      ),
      column: int(
        1,
        1e6,
        "1-based UTF-16 source column. Point at the symbol name itself for call hierarchy operations.",
      ),
      include_declaration: bool("For references, include the declaration itself. Defaults to true."),
      max_results: int(1, 100, "Maximum semantic results returned. Defaults to 50."),
    },
    ["operation"],
  ),
);
tool(
  "get_file_outline",
  "Extract the structural outline (classes, methods, functions, interfaces and line ranges) of a source file using VS Code document symbol providers. Use this to quickly understand the architecture of large files without reading their implementation code.",
  obj({ path: str(512, "Workspace-relative source file to inspect.") }, ["path"]),
);
tool(
  "git_status",
  "Read structured source control state for the workspace root: current branch, ahead/behind counts against the upstream, and staged, unstaged, untracked and conflicted file groups. Use this instead of parsing the text output of git status through run_command, and read it before editing so you never build a patch on top of changes you have not accounted for. This is strictly read-only, stays available while shell execution is disabled, and never runs a command that mutates the repository - use run_command for commit, reset, checkout or any other write.",
  obj({
    include_diff_stat: bool(
      "Also return per-file added/deleted line counts for staged and unstaged changes. Defaults to false.",
    ),
  }),
);
tool(
  "git_diff",
  "Return a bounded unified diff for the working tree or the index. Use it to review exactly what changed before writing a patch or describing work to the user; pair it with git_status, which lists which files changed. Pass staged:true to inspect what is already in the index. Read-only. If truncated=true, request a single path or lower context_lines rather than repeating the call.",
  obj({
    path: str(512, "Limit the diff to one workspace-relative file. Omit for every changed file."),
    staged: bool("Diff the index against HEAD instead of the working tree. Defaults to false."),
    context_lines: int(0, 10, "Unified context lines around each hunk. Defaults to 3."),
    max_chars: int(1e3, 6e4, "Maximum diff characters returned. Defaults to 20000; hard maximum 60000."),
  }),
);
tool(
  "set_todos",
  "Replace the durable task list shown to the local user in the ShunCode panel. Use it for multi-step work and send the COMPLETE ordered list every time the plan changes. Keep at most one task in_progress and reuse stable ids across updates. Keep items at goal level - do not create one todo per tool call; use report_progress for transient detail. Send an empty list to clear the panel. The list is not persisted after disconnect.",
  obj(
    {
      todos: arr(
        obj(
          {
            id: str(80, "Stable identifier reused across later set_todos calls."),
            title: str(400, "Goal-level task title, not an individual tool call."),
            status: enumOf(
              ["pending", "in_progress", "completed"],
              "Current state. At most one task may be in_progress.",
            ),
          },
          ["id", "title", "status"],
        ),
        24,
        "The complete ordered task list, replacing any previous list.",
      ),
    },
    ["todos"],
  ),
);
tool(
  "report_progress",
  "Report what you are doing right now to the local control panel. Use set_todos for durable task state and this tool for transient detail; report meaningful milestones rather than every tool call. When exactly one todo is in_progress the update is associated with it automatically. This tool never modifies workspace files, and the local UI treats its text as untrusted remote content.",
  obj(
    {
      message: str(2e3, "Human-readable description of the current activity."),
      phase: str(
        160,
        "Short phase label such as Reading, Editing, Testing or Done. Rendered as a chip next to the message; omitting it clears the previous label.",
      ),
      percent: int(
        0,
        100,
        "Optional completion estimate, rendered as a progress bar. Omit it when there is no meaningful estimate rather than sending a guess; omitting it hides the bar.",
      ),
      todo_id: str(
        80,
        "Todo id from set_todos, used to highlight that task in the panel. Omit when exactly one todo is in_progress; it is then matched automatically. An id that matches no todo is ignored.",
      ),
    },
    ["message"],
  ),
);
tool(
  "skill",
  "Load a bundled expert workflow for the task at hand. Call with no arguments to get the index of available skills with their descriptions, then call again with name to load that skill's full instructions. Consult the index when starting a non-trivial task such as reviewing code, debugging a failure or refactoring; a matching skill encodes the expected procedure for this workspace and should be followed. Skills are read-only guidance and never modify files.",
  obj({ name: str(64, "Skill name from the index. Omit to list all available skills.") }),
);
function validate(t, e, r = "arguments") {
  if (e.type === "object") {
    if (!t || typeof t != "object" || Array.isArray(t)) throw Error(`${r}: expected object`);
    if (Object.keys(t).length > (e.maxProperties || 60)) throw Error(`${r}: too many properties`);
    for (let n of e.required || []) if (!Object.hasOwn(t, n)) throw Error(`${r}.${n}: required`);
    for (let [n, o] of Object.entries(t)) {
      if (["__proto__", "constructor", "prototype"].includes(n)) throw Error("Unsafe property");
      let s = e.properties?.[n];
      if (s) validate(o, s, `${r}.${n}`);
      else if (e.additionalProperties && typeof e.additionalProperties == "object")
        validate(o, e.additionalProperties, `${r}.${n}`);
      else throw Error(`${r}.${n}: unsupported argument`);
    }
  } else if (e.type === "array") {
    if (!Array.isArray(t) || t.length > e.maxItems) throw Error(`${r}: invalid array`);
    for (let n of t) validate(n, e.items, r);
  } else if (e.type === "integer") {
    if (!Number.isSafeInteger(t) || t < e.minimum || t > e.maximum) throw Error(`${r}: integer out of range`);
  } else if (typeof t !== e.type) throw Error(`${r}: expected ${e.type}`);
  if (typeof t == "string" && (t.length < (e.minLength || 0) || t.length > (e.maxLength || 1 / 0)))
    throw Error(`${r}: text length out of range`);
  if (e.enum && !e.enum.includes(t)) throw Error(`${r}: unsupported value`);
}
module.exports = { tools, validate };

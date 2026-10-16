# Atlias efficiency

Experimental optional Claude Code mod for Gev. It leaves user prompts, instruction files,
active skills, tool descriptions and schemas intact. When enabled, it asks native ToolSearch
to discover selected built-in tools as needed. Unknown tools and MCP tools keep native placement.

Default off. Configure `pluginConfigs["atlias-efficiency"].options.enabled` in Claude Code
settings, and explicitly set `ENABLE_TOOL_SEARCH=true` only for a qualified endpoint. Load
this folder with `--plugin-dir`, alongside the Atlias plugin. Restart the session when changing
mode; already stored context cannot be restored or rewritten by this mod.

A second switch, `options.skillListing`, also default off and only read when `enabled` is on,
cuts each description in the skill listing to one line of at most 120 characters. Every skill
keeps its whole name and stays available, the listing says that it was cut, and a skill's own
instructions are never changed. It does not depend on ToolSearch.

`options.skillNamesOnly`, default off and only read when `enabled` is on, lists every skill by its
name alone, in order, and says so; it takes precedence over `skillListing`. A skill's own
instructions still load unchanged when it is invoked. Bytes saved are not tokens or solves until a
paired run measures them.

Two more switches, both default off and only read when `enabled` is on:
`options.omitMemorySection` leaves Claude Code's own memory instructions out of the system
prompt (Atlias's memory tools take their place; no other section is touched), and
`options.compactToolText` replaces the long usage notes of Bash, Read and ToolSearch with
short ones. The opening of each description and every schema stay as they are, so with this
switch on the statement above that tool descriptions are left intact no longer holds for
those three tools.

Custom endpoints require actual tool-reference support. A recording probe only proves the
installed client contract; a matched local-model benchmark must establish compatibility and
quality. No token or 20x savings are claimed by this implementation.

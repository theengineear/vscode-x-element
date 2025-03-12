# vscode-x-element

Intellisense for interpolated html used with `x-element`.

![Screen Recording](https://raw.githubusercontent.com/theengineear/vscode-x-element/refs/heads/main/example.gif)

## Features

**Go to Definition** — Command-clicking on a custom element tag name within a
tagged template literal (where the tag name is `html`) will link to the
associated constructor name in the source code used with `customElements.define`
to define the custom element.

**Missing Import Warning** — Custom element tag names which do not appear to be
directly imported will be indicated with a warning diagnostic. Adding a direct
import at the top of the file-in-question should resolve the warning.

**List Properties** — Hovering over a custom element tag name will show a small
menu which enumerates the _public_ properties of the custom element (if a 
definition is successfully found). In addition, the names of the properties will
link directly to their definition in source.

## Design

This extension works by parsing JS into an AST and then parsing any tagged
template literals with the tag name `html`.

It uses VSCode’s Language Server Protocol (LSP) to ensure that all computation
happens _outside_ the client extension for performance gains.

The language server “parses” any documents being viewed in the editor by doing
(roughly) the following:

1. Find any `html`-tagged template literals and tokenize them to store lookups
   to any custom element tag names which are present.
2. Find any `customElements.define` expressions. and for each constructor,
   analyze the constructor (e.g., figure out it’s public property interface) and
   store a lookup from the tag name to the constructor name.
3. For each import at the top of the file, repeat steps (1 & 2). Note that this
   only recurses _once_ through imports. I.e., we only look at direct imports of
   any active file.

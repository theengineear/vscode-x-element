# vscode-x-element

## Develop

**Note: It takes a while for updates to show up in the Marketplace.**

In general, follow the [Publishing Extensions] documentation to package and ship
this extension to the [Visual Studio Marketplace].

You will need to install Visual Studio Code Extensions command line tool
(`vsce`). Something like the following: `npm install -g @vscode/vsce`

### Shipping a pre-release

Note that (at least currently), you have to use _odd_ minor semver versions to
ship a pre-release version and _even_ minor semver versions to ship the actual
releases.

1. Commit your changes.
2. Bump / commit version to use an _odd_ minor version in `package.json`.
3. Package: `vsce package --pre-release`
4. Publish: `vsce publish --pre-release`

[Visual Studio Marketplace]: https://marketplace.visualstudio.com/
[Publishing Extensions]: https://code.visualstudio.com/api/working-with-extensions/publishing-extension

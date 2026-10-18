# Cua Driver

QuatiBot's Local VM installs **Cua Driver 0.20.0** inside a Linux container,
not a desktop application bundle. `server/container-computer.ts` pins the
base image by digest and the PyPI wheels by version and SHA-256:

| Wheel | SHA-256 |
|---|---|
| `cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl` | `f60c35696a37f37ac954935e478ae4754f220856d022036625c9400d72185961` |
| `cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl` | `48833bc5e4c60e701fc9eefb57dbac36ec77ef3990f816fbbe85b4e954af2c77` |

The wheel is installed without dependencies into the container's Python
environment. Its bundled executable is copied to
`/usr/local/libexec/quatibot/cua-driver` and serves MCP requests. The runtime
does not separately install the old `cua-cursor-theme` release archive.

- Package: <https://pypi.org/project/cua-driver/0.20.0/>
- Source project: <https://github.com/trycua/cua/tree/main/libs/cua-driver>
- Cua's MIT license: [LICENSE.md](LICENSE.md).

## Dependency-license coverage

The x64 0.20.0 wheel's metadata declares MIT but the archive does not include
license texts, dependency notices or an SBOM. A dependency-license inventory
verified against the current wheels and their exact build sources is still
needed; the package's MIT declaration does not cover every dependency.

`legacy-0.19.3/` retains the upstream fork's dependency license texts,
attributions and Inter font license as a conservative legal reference.
Those records describe **0.19.3 Linux x64 only**, not the current 0.20.0
wheels or the container base image. They must not be treated as a verified
inventory for the current runtime.

#!/bin/bash
# Locate an OpenFOAM installation, whatever the host layout.
#
# Sourced by the other scripts in this folder. Previously each of them globbed
# /usr/lib/openfoam/openfoam* inline, which is the layout of the openfoam.com
# Debian package installed by install_openfoam.sh inside WSL. That works for
# WSL but finds nothing on a Linux host that installed OpenFOAM from its own
# repositories, so the same scripts can now serve both.
#
# After `foam_setup`, OpenFOAM commands are on the PATH and FOAM_BASHRC holds
# the file that was sourced (empty when the tools were already available).

# Candidate `etc/bashrc` locations, most specific first. The loop keeps the
# LAST match of each glob so the highest version wins, as before.
foam_find_bashrc() {
  # An explicit override wins: the only way to support an unusual prefix or
  # pick a specific version among several.
  if [ -n "${FOAM_BASHRC:-}" ] && [ -f "${FOAM_BASHRC}" ]; then
    return 0
  fi

  # Already-sourced environment (module system, user's own .bashrc).
  if [ -n "${WM_PROJECT_DIR:-}" ] && [ -f "${WM_PROJECT_DIR}/etc/bashrc" ]; then
    FOAM_BASHRC="${WM_PROJECT_DIR}/etc/bashrc"
    return 0
  fi

  # Packages disagree on both capitalisation and depth: the openfoam.com
  # Debian package uses /usr/lib/openfoam/openfoam2412, while the Arch/AUR
  # openfoam-com package nests a version directory under a capitalised parent,
  # /opt/OpenFOAM/OpenFOAM-v2606. Globbing case-insensitively covers the
  # spelling, and the two-level patterns cover the nesting.
  local had_nocaseglob=1
  shopt -q nocaseglob || had_nocaseglob=0
  shopt -s nocaseglob

  FOAM_BASHRC=""
  for d in /usr/lib/openfoam/openfoam* \
           /opt/openfoam* \
           /opt/openfoam*/openfoam-* \
           /usr/lib/openfoam* \
           /usr/share/openfoam* \
           "${HOME}"/OpenFOAM/OpenFOAM-*; do
    [ -f "$d/etc/bashrc" ] && FOAM_BASHRC="$d/etc/bashrc"
  done

  [ "$had_nocaseglob" -eq 0 ] && shopt -u nocaseglob

  [ -n "${FOAM_BASHRC}" ]
}

# Make OpenFOAM usable in the current shell.
# Returns 0 when the tools are callable, 1 when no installation was found.
foam_setup() {
  if foam_find_bashrc; then
    # config.sh emits a harmless bash 5.2 warning; callers source before `set -e`.
    # shellcheck disable=SC1090
    . "${FOAM_BASHRC}" 2>/dev/null
    return 0
  fi

  # Some distribution packages drop the solvers straight into /usr/bin with no
  # bashrc to source. Nothing to set up in that case, but OpenFOAM is present.
  if command -v blockMesh >/dev/null 2>&1; then
    FOAM_BASHRC=""
    return 0
  fi

  return 1
}

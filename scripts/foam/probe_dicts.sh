#!/bin/bash
# Relève la syntaxe exacte des dictionnaires de la version OpenFOAM installée,
# plutôt que de se fier à une syntaxe mémorisée qui varie entre versions.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=find_foam.sh
. "$SCRIPT_DIR/find_foam.sh"
foam_setup || { echo "FOAM_ERROR=OpenFOAM introuvable"; exit 1; }

echo "=== constant/ et system/ d'un cas pimpleFoam RAS ==="
find "$FOAM_TUTORIALS/incompressible/pimpleFoam/RAS/pitzDaily" -type f | sed "s|$FOAM_TUTORIALS/incompressible/pimpleFoam/RAS/pitzDaily/||" | sort

echo
echo "=== constant/transportProperties ==="
cat "$FOAM_TUTORIALS/incompressible/pimpleFoam/RAS/pitzDaily/constant/transportProperties" | grep -v "^//" | grep -v "^ *\\\\" | grep -v "^| " | tail -12

echo
echo "=== constant/turbulenceProperties (ou momentumTransport) ==="
for f in turbulenceProperties momentumTransport; do
  p="$FOAM_TUTORIALS/incompressible/pimpleFoam/RAS/pitzDaily/constant/$f"
  [ -f "$p" ] && echo "--- $f ---" && tail -12 "$p"
done

echo
echo "=== Exemple d'entree oscillante : uniformFixedValue + sine ==="
grep -rl "uniformFixedValue" "$FOAM_TUTORIALS/incompressible" 2>/dev/null | head -3 | while read -r f; do
  echo "--- $f ---"
  grep -A 12 "uniformFixedValue" "$f" | head -18
done

echo
echo "=== Function1 'sine' disponible ? ==="
grep -rh "frequency" "$FOAM_ETC/caseDicts" 2>/dev/null | head -5
find "$FOAM_TUTORIALS" -name "*" -type f -exec grep -l "type *sine" {} \; 2>/dev/null | head -3 | while read -r f; do
  echo "--- $f ---"
  grep -B 4 -A 10 "type *sine" "$f" | head -24
done

echo
echo "=== snappyHexMeshDict de reference ==="
find "$FOAM_TUTORIALS" -name snappyHexMeshDict | head -1

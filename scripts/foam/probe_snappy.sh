#!/bin/bash
# Affiche les dictionnaires de reference du cas motorBike (exemple canonique
# de snappyHexMesh) pour caler la syntaxe exacte de la version installee.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=find_foam.sh
. "$SCRIPT_DIR/find_foam.sh"
foam_setup || { echo "FOAM_ERROR=OpenFOAM introuvable"; exit 1; }

MB="$FOAM_TUTORIALS/incompressible/pisoFoam/LES/motorBike/motorBike"

echo "=== surfaceFeatureExtractDict ==="
sed -n '15,60p' "$MB/system/surfaceFeatureExtractDict"

echo
echo "=== snappyHexMeshDict : entete geometry + castellated ==="
sed -n '17,110p' "$MB/system/snappyHexMeshDict"

echo
echo "=== meshQualityControls du meme dict ==="
grep -n -A 8 "meshQualityControls" "$MB/system/snappyHexMeshDict" | head -20

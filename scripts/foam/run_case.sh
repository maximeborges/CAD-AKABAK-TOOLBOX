#!/bin/bash
# Pipeline OpenFOAM pour un cas d'event genere par src/ipc/foamCase.js.
#
#   run_case.sh <caseDir> <stage> [cores] [endTimeOverride]
#     stage = mesh  -> blockMesh + surfaceFeatureExtract + snappyHexMesh + checkMesh
#             solve -> pimpleFoam (parallele si cores > 1)
#             all   -> les deux
#
# Emet des lignes "FOAM_STAGE=<nom>" et "FOAM_RESULT=<cle>=<valeur>" pour que
# la couche Node suive l'avancement sans parser les logs OpenFOAM.

CASE_DIR="$1"
STAGE="${2:-all}"
CORES="${3:-1}"
END_OVERRIDE="${4:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=find_foam.sh
. "$SCRIPT_DIR/find_foam.sh"

# Sourcer avant `set -e`: config.sh emet un avertissement bash 5.2 inoffensif.
if ! foam_setup; then
  echo "FOAM_ERROR=OpenFOAM introuvable"
  exit 1
fi

set -e
cd "$CASE_DIR" || { echo "FOAM_ERROR=cas introuvable: $CASE_DIR"; exit 1; }
mkdir -p logs

# Permet d'ecourter le calcul (mise au point, apercu rapide) sans regenerer le
# cas, ce qui detruirait le maillage deja construit.
if [ -n "$END_OVERRIDE" ]; then
  foamDictionary -entry endTime -set "$END_OVERRIDE" system/controlDict > /dev/null
  echo "FOAM_RESULT=endTime=$END_OVERRIDE"
fi

# Execute une etape, journalise, et s'arrete en signalant l'utilitaire fautif.
run_step() {
  local name="$1"; shift
  echo "FOAM_STAGE=$name"
  if ! "$@" > "logs/$name.log" 2>&1; then
    echo "FOAM_ERROR=$name a echoue"
    tail -30 "logs/$name.log"
    exit 1
  fi
}

if [ "$STAGE" = "mesh" ] || [ "$STAGE" = "all" ]; then
  run_step blockMesh blockMesh

  # Les aretes vives (levre du flare) ameliorent nettement le snap, mais
  # l'absence de features n'est pas fatale: on continue si l'extraction echoue.
  echo "FOAM_STAGE=surfaceFeatureExtract"
  if ! surfaceFeatureExtract > logs/surfaceFeatureExtract.log 2>&1; then
    echo "FOAM_WARN=surfaceFeatureExtract a echoue, raffinement d'aretes desactive"
    sed -i 's|{ file "vent.eMesh"; level 2; }||' system/snappyHexMeshDict
  fi

  run_step snappyHexMesh snappyHexMesh -overwrite
  run_step checkMesh checkMesh

  CELLS=$(grep -m1 "cells:" logs/checkMesh.log | awk '{print $2}')
  echo "FOAM_RESULT=cells=${CELLS:-0}"
  if grep -q "Mesh OK" logs/checkMesh.log; then
    echo "FOAM_RESULT=meshOk=1"
  else
    echo "FOAM_RESULT=meshOk=0"
    grep -E "\*\*\*|Failed" logs/checkMesh.log | head -10
  fi
fi

if [ "$STAGE" = "solve" ] || [ "$STAGE" = "all" ]; then
  echo "FOAM_RESULT=endTimeUsed=$(foamDictionary -entry endTime -value system/controlDict)"

  # Suit l'avancee du solveur sans attendre la fin: pimpleFoam n'ecrit que dans
  # son log, on le relit periodiquement pour emettre le temps simule courant.
  watch_progress() {
    while kill -0 "$1" 2>/dev/null; do
      T=$(grep "^Time = " logs/pimpleFoam.log 2>/dev/null | tail -1 | awk '{print $3}')
      [ -n "$T" ] && echo "FOAM_PROGRESS=$T"
      sleep 2
    done
  }

  if [ "$CORES" -gt 1 ]; then
    run_step decomposePar decomposePar -force
    echo "FOAM_STAGE=pimpleFoam"
    mpirun --allow-run-as-root -np "$CORES" pimpleFoam -parallel > logs/pimpleFoam.log 2>&1 &
    SOLVER_PID=$!
    watch_progress "$SOLVER_PID"
    if ! wait "$SOLVER_PID"; then
      echo "FOAM_ERROR=pimpleFoam a echoue"
      tail -40 logs/pimpleFoam.log
      exit 1
    fi
    # Les sondes sont ecrites par le maitre: la reconstruction ne sert qu'a
    # relire les champs complets, elle ne doit pas faire echouer le calcul.
    echo "FOAM_STAGE=reconstructPar"
    if ! reconstructPar -newTimes > logs/reconstructPar.log 2>&1; then
      echo "FOAM_WARN=reconstructPar sans effet (aucun instant complet ecrit)"
    fi
  else
    echo "FOAM_STAGE=pimpleFoam"
    pimpleFoam > logs/pimpleFoam.log 2>&1 &
    SOLVER_PID=$!
    watch_progress "$SOLVER_PID"
    if ! wait "$SOLVER_PID"; then
      echo "FOAM_ERROR=pimpleFoam a echoue"
      tail -40 logs/pimpleFoam.log
      exit 1
    fi
  fi

  LAST=$(grep "^Time = " logs/pimpleFoam.log | tail -1 | awk '{print $3}')
  CLOCK=$(grep "ExecutionTime" logs/pimpleFoam.log | tail -1 | awk '{print $7}')
  echo "FOAM_RESULT=lastTime=${LAST:-0}"
  echo "FOAM_RESULT=clockTime=${CLOCK:-0}"
fi

echo "FOAM_RESULT=status=ok"

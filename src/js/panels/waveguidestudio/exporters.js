// ====================================================================================================
// FICHIER :  src/js/panels/waveguidestudio/exporters.js
// RÔLE :     Gestion de l'export des fichiers (STL, CSV, MSH).
// ====================================================================================================

import * as THREE from '../../lib/three.module.js';
import { getSettings } from '../mainsettings/mainsettings.js';
import { generateGeoForDoscBRep } from './dosc/doscBrep.js';

// Total horn length including the optional Throat Adapter pre-section.
function getEffectiveTotalLength(cfg) {
    const main = cfg.segments.reduce((acc, seg) => acc + seg.length, 0);
    const ad = (cfg.throatAdapter && cfg.throatAdapter.enabled)
        ? (cfg.throatAdapter.length || 0) : 0;
    return main + ad;
}

// =====================================================================
// Adaptive mesh sizing ("Adaptive" checkbox in Export MSH / Export to Solver)
// -----------------------------------------------------------------------
// Instead of a single flat `clmax`, a GMSH `Distance` + `Threshold` field pair
// is used so the element size grows smoothly from the throat (fine, better
// captures the acoustic source / high curvature) to the mouth (coarse, flat
// region, keeps triangle count / solve time down).
//
// TO TUNE how aggressive the refinement is, edit the constants below:
//   ADAPTIVE_MIN_FACTOR   - throat element size = clmax / ADAPTIVE_MIN_FACTOR.
//                           Bigger factor = finer mesh at the throat/throat cap.
//   ADAPTIVE_DIST_MIN_FRAC - fraction of the horn length (from the throat)
//                           that stays at the minimum (finest) size.
//                           Bigger = the fine zone extends further into the horn.
//   ADAPTIVE_DIST_MAX_FRAC - fraction of the horn length at which the mesh
//                           reaches the full `clmax` (mouth) size. Smaller =
//                           mesh coarsens faster (reaches clmax closer to the throat).
// =====================================================================
const ADAPTIVE_MIN_FACTOR = 4;
const ADAPTIVE_DIST_MIN_FRAC = 0.08;
const ADAPTIVE_DIST_MAX_FRAC = 0.6;

function normalizeMeshConfig(config = {}) {
    const fallback = { clmax: 10, curvature: 5, adaptive: false };
    const profile = (value, defaults) => ({
        clmax: Number.isFinite(Number(value?.clmax)) && Number(value.clmax) > 0 ? Number(value.clmax) : defaults.clmax,
        curvature: Number.isFinite(Number(value?.curvature)) ? Math.max(0, Number(value.curvature)) : defaults.curvature,
        adaptive: !!value?.adaptive,
    });
    const legacy = profile(config, fallback);
    const source = profile(config.source, { clmax: 4, curvature: 12, adaptive: false });
    const horn = profile(config.horn, config.source || config.horn || config.interface ? { clmax: 8, curvature: 16, adaptive: false } : legacy);
    const interfaceProfile = profile(config.interface, { clmax: 8, curvature: 12, adaptive: false });
    return {
        source,
        horn,
        interface: interfaceProfile,
        // Compatibility values used by the DOSC exporters and the global Gmsh curvature setting.
        clmax: Math.min(source.clmax, horn.clmax, interfaceProfile.clmax),
        curvature: Math.max(source.curvature, horn.curvature, interfaceProfile.curvature),
        adaptive: horn.adaptive,
    };
}

/**
 * Emits a per-surface (or, for the adaptive horn, a Distance/Threshold-based)
 * Gmsh size field and returns its field id, WITHOUT touching the global
 * `Background Field` — callers combine every group's field with a `Min`
 * field so each physical surface keeps its own clmax (see `emitGroupSizeField`
 * below for why a flat `MeshSize{PointsOf{...}}` per group is not enough).
 */
function emitMeshSizingLines(lines, meshConfig, throatCurveIds, totalLength, fieldIdStart, surfaceExpr) {
    const clmax = meshConfig.clmax;
    let nextFieldId = fieldIdStart;
    if (meshConfig.adaptive && throatCurveIds && throatCurveIds.length && totalLength > 0) {
        const sizeMin = clmax / ADAPTIVE_MIN_FACTOR;
        const distMin = totalLength * ADAPTIVE_DIST_MIN_FRAC;
        const distMax = totalLength * ADAPTIVE_DIST_MAX_FRAC;
        const distId = nextFieldId++;
        const threshId = nextFieldId++;
        lines.push('// --- Adaptive mesh sizing (fine at throat, coarser toward mouth) ---');
        lines.push(`Field[${distId}] = Distance;`);
        lines.push(`Field[${distId}].CurvesList = {${throatCurveIds.join(', ')}};`);
        lines.push(`Field[${distId}].Sampling = 100;`);
        lines.push(`Field[${threshId}] = Threshold;`);
        lines.push(`Field[${threshId}].InField = ${distId};`);
        lines.push(`Field[${threshId}].SizeMin = ${sizeMin};`);
        lines.push(`Field[${threshId}].SizeMax = ${clmax};`);
        lines.push(`Field[${threshId}].DistMin = ${distMin};`);
        lines.push(`Field[${threshId}].DistMax = ${distMax};`);
        return emitRestrict(lines, threshId, surfaceExpr, nextFieldId);
    }
    return emitGroupSizeField(lines, clmax, surfaceExpr, fieldIdStart);
}

/**
 * Wraps `inFieldId` in a `Restrict` field scoped to `surfaceExpr` (a Gmsh
 * surface tag or list, e.g. `_g1()`). Needed for the adaptive horn's
 * Distance/Threshold pair, which (unlike `Constant`, see `emitGroupSizeField`)
 * has no entity-list option of its own.
 */
function emitRestrict(lines, inFieldId, surfaceExpr, fieldIdStart) {
    if (!surfaceExpr) return { fieldId: inFieldId, nextFieldId: fieldIdStart };
    const restrictId = fieldIdStart;
    lines.push(`Field[${restrictId}] = Restrict;`);
    lines.push(`Field[${restrictId}].InField = ${inFieldId};`);
    lines.push(`Field[${restrictId}].SurfacesList = {${surfaceExpr}};`);
    return { fieldId: restrictId, nextFieldId: restrictId + 1 };
}

/**
 * Emits a `Constant` field (value `clmax`) scoped to `surfaceExpr` via its
 * own `SurfacesList` option. Gmsh's `Constant` field returns `VOut` (default
 * = "no constraint") for any entity not in its own entity lists, so setting
 * `SurfacesList` directly (rather than wrapping in a separate `Restrict`
 * field) is both sufficient and required: a `Constant` field with no entity
 * list of its own always evaluates to "no constraint" everywhere, even when
 * wrapped in a `Restrict` field — the outer `Restrict` only gates WHEN the
 * inner field is queried, it doesn't grant it any entities of its own.
 */
function emitGroupSizeField(lines, clmax, surfaceExpr, fieldIdStart) {
    const constId = fieldIdStart;
    lines.push(`Field[${constId}] = Constant;`);
    lines.push(`Field[${constId}].VIn = ${clmax};`);
    if (surfaceExpr) lines.push(`Field[${constId}].SurfacesList = {${surfaceExpr}};`);
    return { fieldId: constId, nextFieldId: constId + 1 };
}

// =====================================================================
// Export to Directivity Calculator
// Samples the waveguide profile into piecewise rectangular segments
// (w, h, l in mm) and dispatches an 'export-to-directivity' event with
// the same payload shape as Horn Studio.
// =====================================================================
export async function exportToDirectivity(config, profileH, profileV, finalDimensions, btn) {
    const setStatus = (msg, isError = false) => {
        if (!btn) return;
        const orig = btn.dataset.origText || btn.textContent;
        btn.dataset.origText = orig;
        btn.textContent = msg;
        btn.classList.toggle('text-red-300', isError);
        setTimeout(() => {
            btn.textContent = orig;
            btn.classList.remove('text-red-300');
            delete btn.dataset.origText;
        }, 2500);
    };

    if (!profileH || profileH.length < 2) {
        setStatus('No profile — generate first', true);
        return false;
    }

    // Sort by axial coordinate (profile.point.y is z)
    const sortedH = [...profileH].sort((a, b) => a.point.y - b.point.y);
    const sortedV = profileV && profileV.length >= 2
        ? [...profileV].sort((a, b) => a.point.y - b.point.y)
        : null;

    // Target ~16 rectangular slices (+2 clamps) to keep BEM mesh manageable.
    const TARGET = 16;
    const N = Math.min(sortedH.length, Math.max(2, TARGET));

    // Uniform z-sampling on [0, totalLength]
    const z0 = sortedH[0].point.y;
    const zEnd = sortedH[sortedH.length - 1].point.y;
    const totalLen = Math.max(1e-6, zEnd - z0);

    const interpRadius = (profile, z) => {
        // Linear interpolation on sorted profile
        if (z <= profile[0].point.y) return profile[0].point.x;
        if (z >= profile[profile.length - 1].point.y) return profile[profile.length - 1].point.x;
        for (let i = 0; i < profile.length - 1; i++) {
            const a = profile[i].point, b = profile[i + 1].point;
            if (z >= a.y && z <= b.y) {
                const t = (z - a.y) / Math.max(1e-9, b.y - a.y);
                return a.x + t * (b.x - a.x);
            }
        }
        return profile[profile.length - 1].point.x;
    };

    // Build slices
    const slices = [];
    for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        const z = z0 + t * totalLen;
        const rH = interpRadius(sortedH, z);
        const rV = sortedV ? interpRadius(sortedV, z) : rH;
        slices.push({ z, rH, rV });
    }

    // If final output is rectangular, scale the mouth slice so w/h match the
    // rectangular dimensions reported by the renderer (profile radius is the
    // equivalent-area circular radius).
    const outShape = (config && config.outputShape) || 'circle';
    if (finalDimensions && outShape !== 'circle') {
        const last = slices[slices.length - 1];
        const halfW = finalDimensions.width / 2;
        const halfH = finalDimensions.height / 2;
        // Replace only if dims are valid
        if (halfW > 0 && halfH > 0) {
            last.rH = halfW;
            last.rV = halfH;
        }
    }

    // Convert slices to {w, h, l} segments (Horn Studio format).
    // Each entry i carries the cross-section at slice i and the length
    // to the next slice. The last entry's length is ignored downstream.
    const segments = [];
    for (let i = 0; i < slices.length; i++) {
        const w = 2 * slices[i].rH;
        const h = 2 * slices[i].rV;
        const l = (i < slices.length - 1) ? (slices[i + 1].z - slices[i].z) : 0;
        segments.push({ w, h, l });
    }

    // Mouth dimensions (last slice)
    const last = segments[segments.length - 1];
    const prev = segments[segments.length - 2];
    const lastSegmentWidth = last.w;
    const lastSegmentHeight = last.h;

    // Wall angles computed from last expansion step
    const deltaW = last.w - prev.w;
    const deltaH = last.h - prev.h;
    const segLen = prev.l || 1;
    const calculatedWallAngleH = 2 * (Math.atan((deltaW / 2) / segLen) * 180 / Math.PI);
    const calculatedWallAngleV = 2 * (Math.atan((deltaH / 2) / segLen) * 180 / Math.PI);

    // Expansion type from first segment's law
    const lawMap = { 'OS-SE': 'OS-SE', 'OS': 'OS', 'Hypex': 'Hypex', 'Bessel': 'Bessel' };
    const rawLaw = (config && config.segments && config.segments[0] && config.segments[0].law) || 'Conical';
    const expansionType = lawMap[rawLaw] || 'Conical';

    // Cutoff frequency — same formula as Horn Studio (fc = 116 / L, L in m)
    const totalLengthMm = segments.reduce((acc, s) => acc + (s.l || 0), 0);
    const cutoffFrequency = totalLengthMm > 0 ? 116 / (totalLengthMm / 1000) : 200;

    const payload = {
        lastSegmentWidth,
        lastSegmentHeight,
        calculatedWallAngleH,
        calculatedWallAngleV,
        expansionType,
        cutoffFrequency,
        segments: segments.map(s => ({ w: Number(s.w), h: Number(s.h), l: Number(s.l) || 0 })),
    };

    try {
        if (typeof window.showTool === 'function') window.showTool('directivity', 'Directivity Calculator');
        setTimeout(() => {
            console.log('[Waveguide→Directivity] exporting payload:', payload);
            window.panelEvents.dispatchEvent(new CustomEvent('export-to-directivity', { detail: payload }));
        }, 100);
        setStatus('Exported ✓');
        return true;
    } catch (e) {
        console.error('[Waveguide→Directivity] failed', e);
        setStatus('Export failed', true);
        return false;
    }
}

// Read a vertex coordinate at full Float64 precision when the geometry was
// produced by the Waveguide renderer (which stashes the raw double-precision
// stream in `userData.preciseVertices`). Falls back to the Float32 buffer.
function getPreciseXYZ(geom, idx) {
    const pv = geom.userData && geom.userData.preciseVertices;
    if (pv && idx * 3 + 2 < pv.length) {
        return [pv[idx * 3], pv[idx * 3 + 1], pv[idx * 3 + 2]];
    }
    const pos = geom.attributes.position;
    return [pos.getX(idx), pos.getY(idx), pos.getZ(idx)];
}

function mergeGeometries(geometries) {
    const mergedVertices = [], mergedIndices = [], mergedPrecise = [];
    let vertexCountOffset = 0;
    let anyPrecise = false;
    for (const geom of geometries) {
        if (!geom || !geom.attributes.position) continue;
        const pos = geom.attributes.position;
        mergedVertices.push(...pos.array);
        const pv = geom.userData && geom.userData.preciseVertices;
        if (pv && pv.length === pos.count * 3) {
            for (let k = 0; k < pv.length; k++) mergedPrecise.push(pv[k]);
            anyPrecise = true;
        } else {
            for (let k = 0; k < pos.array.length; k++) mergedPrecise.push(pos.array[k]);
        }
        if (geom.index) {
            for (let i = 0; i < geom.index.count; i++) {
                mergedIndices.push(geom.index.array[i] + vertexCountOffset);
            }
        }
        vertexCountOffset += pos.count;
    }
    const mergedGeometry = new THREE.BufferGeometry();
    if (mergedVertices.length > 0) {
        mergedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(mergedVertices, 3));
        mergedGeometry.setIndex(mergedIndices);
        if (anyPrecise) {
            mergedGeometry.userData.preciseVertices = new Float64Array(mergedPrecise);
        }
    }
    return mergedGeometry;
}

export function generateSTLString(geometry) {
    if (!geometry) return "";
    let stl = "solid waveguide\n";
    const indices = geometry.index ? geometry.index.array : null;
    if (indices) {
        for (let i = 0; i < indices.length; i += 3) {
            const [a0, a1, a2] = getPreciseXYZ(geometry, indices[i]);
            const [b0, b1, b2] = getPreciseXYZ(geometry, indices[i + 1]);
            const [c0, c1, c2] = getPreciseXYZ(geometry, indices[i + 2]);
            const v1 = new THREE.Vector3(a0, a1, a2);
            const v2 = new THREE.Vector3(b0, b1, b2);
            const v3 = new THREE.Vector3(c0, c1, c2);
            const n = new THREE.Triangle(v1, v2, v3).getNormal(new THREE.Vector3());
            stl += `facet normal ${n.x} ${n.y} ${n.z}\n    outer loop\n`;
            stl += `        vertex ${v1.x} ${v1.y} ${v1.z}\n        vertex ${v2.x} ${v2.y} ${v2.z}\n        vertex ${v3.x} ${v3.y} ${v3.z}\n`;
            stl += `    endloop\nendfacet\n`;
        }
    }
    return stl + "endsolid waveguide\n";
}

export function generateCSVString(geometry) {
    if (!geometry) return "";
    const pos = geometry.attributes.position;
    let csv = "";
    for (let i = 0; i < pos.count; i++) csv += `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}\n`;
    return csv;
}

export function generateProfileCSVString(geometry, config) {
    if (!geometry || !config) return "";
    const points = new Set(), pos = geometry.attributes.position, numLines = config.numLines, numProfilePoints = pos.count / numLines;
    const addPoint = (i, j) => {
        const idx = i * numLines + j;
        if (idx < pos.count) points.add(`${pos.getX(idx).toFixed(4)},${pos.getY(idx).toFixed(4)},${pos.getZ(idx).toFixed(4)}`);
    };
    for (let j = 0; j < numLines; j++) { addPoint(0, j); addPoint(numProfilePoints - 1, j); }
    const jH1 = 0, jH2 = numLines / 2, jV1 = numLines / 4, jV2 = 3 * numLines / 4;
    for (let i = 0; i < numProfilePoints; i++) { addPoint(i, jH1); addPoint(i, jH2); addPoint(i, jV1); addPoint(i, jV2); }
    return Array.from(points).join('\n');
}

export function generateMSHString(geometries) {
    let totalNodes = 0, totalElements = 0;
    geometries.forEach(g => { if (g.geometry) { totalNodes += g.geometry.attributes.position.count; if (g.geometry.index) totalElements += g.geometry.index.count / 3; } });
    if (totalNodes === 0 || totalElements === 0) return "";
    let msh = "$MeshFormat\n2.2 0 8\n$EndMeshFormat\n$PhysicalNames\n" + geometries.length + "\n";
    geometries.forEach((g, i) => { msh += `2 ${i + 1} "${g.name}"\n`; });
    msh += `$EndPhysicalNames\n$Nodes\n${totalNodes}\n`;
    let nodeIndex = 1;
    geometries.forEach(g => { if (g.geometry) { const vertices = g.geometry.attributes.position; for (let i = 0; i < vertices.count; i++) msh += `${nodeIndex++} ${vertices.getX(i)} ${vertices.getY(i)} ${vertices.getZ(i)}\n`; } });
    msh += "$EndNodes\n$Elements\n" + totalElements + "\n";
    let elementIndex = 1, nodeOffset = 0;
    geometries.forEach((g, i) => {
        if (g.geometry && g.geometry.index) {
            const indices = g.geometry.index.array, tag = i + 1;
            for (let j = 0; j < indices.length; j += 3) msh += `${elementIndex++} 2 2 ${tag} ${tag} ${indices[j]+1+nodeOffset} ${indices[j+1]+1+nodeOffset} ${indices[j+2]+1+nodeOffset}\n`;
            nodeOffset += g.geometry.attributes.position.count;
        }
    });
    return msh + "$EndElements\n";
}

export async function exportFileInDirectory(content, directory, fileName, statusButton) {
    const showStatus = (message, isError = false) => {
        if (!statusButton) return;
        const originalText = statusButton.textContent;
        statusButton.textContent = message;
        statusButton.classList.toggle('text-red-400', isError);
        statusButton.classList.toggle('text-green-400', !isError);
        setTimeout(() => { statusButton.textContent = originalText; statusButton.classList.remove('text-red-400', 'text-green-400'); }, 3000);
    };
    if (!content) { showStatus("Content Error", true); return; }
    if (!directory) { showStatus("Path missing!", true); return; }
    const result = await window.electronAPI.saveFileInDirectory({ directory, fileName, content });
    if (result.success) showStatus("Exported!");
    else { console.error(`Error exporting to ${directory}\\${fileName}:`, result.error); showStatus("File Error!", true); }
}

export async function exportSTL(getGeometries, lastConfig, exportButton) {
    const { waveguide, interface: iface, throatCap } = getGeometries();
    const finalGeom = mergeGeometries([waveguide, iface, throatCap].filter(Boolean));
    const totalLength = getEffectiveTotalLength(lastConfig);
    finalGeom.translate(0, 0, -totalLength);
    finalGeom.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));

    // Apply the SAME transforms to the Float64 precise stream so STL output
    // uses double-precision coordinates (otherwise THREE's Float32 buffer
    // truncates 12.7 to 12.69999961... and the throat diameter drifts).
    const pv = finalGeom.userData && finalGeom.userData.preciseVertices;
    if (pv) {
        for (let i = 0; i < pv.length; i += 3) {
            // Translate Z by -totalLength
            const zT = pv[i + 2] - totalLength;
            // Rotate -π/2 around X: (x, y, z) → (x, z, -y)
            const x = pv[i];
            const y = pv[i + 1];
            pv[i]     = x;
            pv[i + 1] = zT;
            pv[i + 2] = -y;
        }
    }

    if (finalGeom) { 
        const s = await getSettings(); 
        const c = generateSTLString(finalGeom); 
        const stlPath = s.paths.dataRoot ? `${s.paths.dataRoot}\\STL-out` : '';
        await exportFileInDirectory(c, stlPath, 'waveguide.stl', exportButton); 
    }
}

export async function exportCSV(getGeometries, exportButton) {
    const geom = getGeometries().waveguide;
    if (geom) { 
        const s = await getSettings(); 
        const c = generateCSVString(geom); 
        const csvPath = s.paths.dataRoot ? `${s.paths.dataRoot}\\CSV-out` : '';
        await exportFileInDirectory(c, csvPath, 'waveguide_points_full.csv', exportButton); 
    }
}

export async function exportProfileCSV(getGeometries, lastConfig, exportButton) {
    const geom = getGeometries().fullWaveguide;
    if (geom) { 
        const s = await getSettings(); 
        const c = generateProfileCSVString(geom, lastConfig); 
        const csvPath = s.paths.dataRoot ? `${s.paths.dataRoot}\\CSV-out` : '';
        await exportFileInDirectory(c, csvPath, 'waveguide_profile.csv', exportButton); 
    }
}

export async function exportMSH(getGeometries, lastConfig, buildInterface, exportButton) {
    const geoms = getGeometries();
    if (!geoms.waveguide) return;
    const totalLength = getEffectiveTotalLength(lastConfig);
    const translationZ = -totalLength;
    const rotMatrix = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    const geomsToExport = [{ geometry: geoms.waveguide.clone().translate(0, 0, translationZ).applyMatrix4(rotMatrix), name: "waveguide_surface" }];
    if (buildInterface) {
        const ifaceMerged = mergeGeometries([geoms.interfaceWall, geoms.interfaceFace].filter(Boolean));
        if (ifaceMerged) geomsToExport.push({ geometry: ifaceMerged.clone().translate(0, 0, translationZ).applyMatrix4(rotMatrix), name: "interface_surface" });
        if (geoms.throatCap) geomsToExport.push({ geometry: geoms.throatCap.clone().translate(0, 0, translationZ).applyMatrix4(rotMatrix), name: "throat_cap_surface" });
    }
    const settings = await getSettings();
    const content = generateMSHString(geomsToExport);
    const meshPath = settings.paths.dataRoot ? `${settings.paths.dataRoot}\\Mesh-out` : '';
    await exportFileInDirectory(content, meshPath, 'waveguide_sim.msh', exportButton);
}

/**
 * Export cross-sections as individual DXF files for Onshape CAD import.
 * Each DXF contains a closed LWPOLYLINE of the cross-section at a given Z.
 * The user imports each DXF as a sketch on an offset plane, then lofts.
 */
function generateDXFString(points2D) {
    let dxf = '0\nSECTION\n2\nHEADER\n0\nENDSEC\n';
    dxf += '0\nSECTION\n2\nENTITIES\n';
    dxf += '0\nLWPOLYLINE\n8\n0\n';
    dxf += `90\n${points2D.length}\n`;
    dxf += '70\n1\n'; // closed
    for (const p of points2D) {
        dxf += `10\n${p.x.toFixed(6)}\n20\n${p.y.toFixed(6)}\n`;
    }
    dxf += '0\nENDSEC\n0\nEOF\n';
    return dxf;
}

async function getNextNumberedFolder(basePath, prefix) {
    const result = await window.electronAPI.listDirectory(basePath);
    let maxNum = 0;
    if (result.success) {
        for (const entry of result.entries) {
            if (entry.isDirectory && entry.name.startsWith(prefix)) {
                const num = parseInt(entry.name.replace(prefix, '').trim(), 10);
                if (!isNaN(num) && num > maxNum) maxNum = num;
            }
        }
    }
    return `${basePath}\\${prefix} ${maxNum + 1}`;
}

function extractSlices(geom, lastConfig) {
    const pos = geom.attributes.position;
    const N = lastConfig.numLines;
    const totalSlices = Math.floor(pos.count / N);
    const totalLength = getEffectiveTotalLength(lastConfig);
    const slices = [];
    for (let i = 0; i < totalSlices; i++) {
        const points2D = [];
        for (let j = 0; j < N; j++) {
            const idx = i * N + j;
            if (idx >= pos.count) break;
            points2D.push({ x: pos.getX(idx), y: pos.getY(idx) });
        }
        // Mouth at Y=0, throat at -totalLength (depth into -Y)
        if (points2D.length < 3) {
            const z = pos.getZ(i * N);
            slices.push({ points2D, z, zFromThroat: z - totalLength });
            continue;
        }
        const z = pos.getZ(i * N);
        slices.push({ points2D, z, zFromThroat: z - totalLength });
    }
    return slices;
}

export async function exportDXFSections(getGeometries, lastConfig, exportButton) {
    const geom = getGeometries().fullWaveguide;
    if (!geom || !geom.attributes.position) return;

    const settings = await getSettings();
    const basePath = settings.paths.dataRoot ? `${settings.paths.dataRoot}\\DXF-sections` : '';
    if (!basePath) {
        if (exportButton) { exportButton.textContent = 'Path missing!'; setTimeout(() => { exportButton.textContent = 'Export DXF Sections'; }, 3000); }
        return;
    }

    const dxfPath = await getNextNumberedFolder(basePath, 'waveguide');
    const slices = extractSlices(geom, lastConfig);
    let exported = 0;

    for (let i = 0; i < slices.length; i++) {
        const s = slices[i];
        if (s.points2D.length < 3) continue;
        const padded = String(i + 1).padStart(3, '0');
        const fileName = `section_${padded}_z${s.zFromThroat.toFixed(1)}mm.dxf`;
        await exportFileInDirectory(generateDXFString(s.points2D), dxfPath, fileName, null);
        exported++;
    }

    if (exportButton) {
        exportButton.textContent = `${exported} DXF → ${dxfPath.split('\\').pop()}`;
        exportButton.classList.add('text-green-400');
        setTimeout(() => { exportButton.textContent = 'Export DXF Sections'; exportButton.classList.remove('text-green-400'); }, 3000);
    }
}

export async function exportCSVSections(getGeometries, lastConfig, exportButton) {
    const geom = getGeometries().fullWaveguide;
    if (!geom || !geom.attributes.position) return;

    const settings = await getSettings();
    const basePath = settings.paths.dataRoot ? `${settings.paths.dataRoot}\\CSV-out\\waveguide-sections` : '';
    if (!basePath) {
        if (exportButton) { exportButton.textContent = 'Path missing!'; setTimeout(() => { exportButton.textContent = 'Tranches (.CSV)'; }, 3000); }
        return;
    }

    const csvPath = await getNextNumberedFolder(basePath, 'waveguide');
    const slices = extractSlices(geom, lastConfig);
    let exported = 0;

    for (let i = 0; i < slices.length; i++) {
        const s = slices[i];
        if (s.points2D.length < 3) continue;
        let csv = 'x,y\n';
        for (const p of s.points2D) csv += `${p.x.toFixed(6)},${p.y.toFixed(6)}\n`;
        const padded = String(i + 1).padStart(3, '0');
        const fileName = `section_${padded}_z${s.zFromThroat.toFixed(1)}mm.csv`;
        await exportFileInDirectory(csv, csvPath, fileName, null);
        exported++;
    }

    if (exportButton) {
        exportButton.textContent = `${exported} CSV → ${csvPath.split('\\').pop()}`;
        exportButton.classList.add('text-green-400');
        setTimeout(() => { exportButton.textContent = 'Tranches (.CSV)'; exportButton.classList.remove('text-green-400'); }, 3000);
    }
}

/**
 * Export cross-sections for Onshape FeatureScript import.
 * Selects ~15 key cross-sections and writes:
 *   - One combined CSV (section,z_mm,x_mm,y_mm) for FeatureScript TableData import
 *   - Individual section CSVs (x,y) in the same folder for reference
 * Exported into a numbered folder: CSV-out/onshape-sections/waveguide 1/
 */
function selectKeySlices(slices, targetCount) {
    if (slices.length <= targetCount) return slices.map((s, i) => ({ ...s, origIndex: i }));
    const selected = [{ ...slices[0], origIndex: 0 }];
    const inner = targetCount - 2;
    for (let i = 1; i <= inner; i++) {
        const t = i / (inner + 1);
        const idx = Math.round(t * (slices.length - 1));
        if (idx > 0 && idx < slices.length - 1) {
            selected.push({ ...slices[idx], origIndex: idx });
        }
    }
    selected.push({ ...slices[slices.length - 1], origIndex: slices.length - 1 });
    const seen = new Set();
    return selected.filter(s => { if (seen.has(s.origIndex)) return false; seen.add(s.origIndex); return true; });
}

export async function exportOnshapeCSV(getGeometries, lastConfig, exportButton) {
    const geom = getGeometries().fullWaveguide;
    if (!geom || !geom.attributes.position) return;

    const settings = await getSettings();
    const basePath = settings.paths.dataRoot ? `${settings.paths.dataRoot}\\CSV-out\\onshape-sections` : '';
    if (!basePath) {
        if (exportButton) { exportButton.textContent = 'Path missing!'; setTimeout(() => { exportButton.textContent = 'Onshape (.CSV)'; }, 3000); }
        return;
    }

    const folderPath = await getNextNumberedFolder(basePath, 'waveguide');

    const allSlices = extractSlices(geom, lastConfig);
    const validSlices = allSlices.filter(s => s.points2D.length >= 3);
    const keySlices = selectKeySlices(validSlices, 15);

    // 1. Combined CSV for FeatureScript import (single TableData)
    let combinedCsv = 'section,z_mm,x_mm,y_mm\n';
    for (let si = 0; si < keySlices.length; si++) {
        const slice = keySlices[si];
        const sec = si + 1;
        const z = slice.zFromThroat.toFixed(4);
        for (const p of slice.points2D) {
            combinedCsv += `${sec},${z},${p.x.toFixed(6)},${p.y.toFixed(6)}\n`;
        }
    }
    await exportFileInDirectory(combinedCsv, folderPath, 'waveguide_onshape.csv', null);

    // 2. Individual section CSVs
    for (let si = 0; si < keySlices.length; si++) {
        const slice = keySlices[si];
        const padded = String(si + 1).padStart(2, '0');
        let sectionCsv = 'x,y\n';
        for (const p of slice.points2D) {
            sectionCsv += `${p.x.toFixed(6)},${p.y.toFixed(6)}\n`;
        }
        const fileName = `section_${padded}_z${slice.zFromThroat.toFixed(1)}mm.csv`;
        await exportFileInDirectory(sectionCsv, folderPath, fileName, null);
    }

    if (exportButton) {
        const folderName = folderPath.split('\\').pop();
        const label = `${keySlices.length} sections → ${folderName}`;
        exportButton.textContent = label;
        exportButton.classList.add('text-green-400');
        setTimeout(() => { exportButton.textContent = 'Onshape (.CSV)'; exportButton.classList.remove('text-green-400'); }, 3000);
    }
}

// ====================================================================================================
// STEP EXPORT — Generates a GMSH .geo file with OpenCASCADE ThruSections loft,
// then calls GMSH in geometry-only mode (-0) to produce a smooth B-Rep STEP file.
// Exports exactly what the user sees: respects split H/V, interface toggle.
// Horn, interface wall+face and throat cap are 4 separate clean surfaces.
// ====================================================================================================

/**
 * Remove consecutive duplicate XY points (same position within tolMm).
 * At pinAngle=0 (DOSC midpoint) sampleClippedEllipse produces Nq
 * coincident points at (±aCone, 0). Those degenerate BSpline control-
 * point clusters make OCC ThruSections produce holes/folds even with
 * degree=1. Deduplication collapses each cluster to one point.
 */
function deduplicateRing(pts, tolMm = 0.1) {
    if (pts.length < 2) return pts;
    const tol2 = tolMm * tolMm;
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        const p = pts[i], q = out[out.length - 1];
        if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 > tol2) out.push(p);
    }
    return out;
}

/**
 * Re-sample a sorted ring (or open arc) to exactly Nout points at FIXED
 * reference angles spanning [angMin, angMax].
 *
 * Why fixed reference angles (not data-relative):
 *   Earlier we resampled at angMin = ang[0] + (i/N)·span, but ang[0]
 *   varies slightly between sections (e.g. 0.001 in one, 0.05 in another)
 *   because the input vertices land at different angles in each section.
 *   That tiny shift causes OCC ThruSections to twist the loft, producing
 *   visible creases.  Using *fixed* targets (i·2π/N for closed, or
 *   angMin + i·span/(N-1) where angMin/angMax are the snap-plane angles
 *   for open arcs) guarantees every section's control point k sits at
 *   the *exact same* angle → OCC sees perfectly compatible wires → loft
 *   is fold-free.
 *
 * closed = true  : full ring.  angMin = 0, angMax = 2π (caller's convention).
 *                   Points wrap around: target may fall before ang[0] or
 *                   after ang[n-1] — handled by ±2π wrap-around extension.
 * closed = false : open arc.  angMin/angMax must match the snap-plane
 *                   angles (e.g. 0 and π for H-split).  Endpoints must
 *                   have been snapped onto these angles BEFORE this call.
 */
function uniformAngleSample(pts, Nout, angMin, angMax, closed) {
    const n = pts.length;
    if (n < 2 || Nout < 2) return pts.slice();
    // Angle convention matches the sort convention used by the caller.
    const angleOf = closed
        ? p => { const a = Math.atan2(p.y, p.x); return a < 0 ? a + 2 * Math.PI : a; }
        : p => Math.atan2(p.y, p.x);
    const ang = pts.map(angleOf);

    // Extend with wrap-around on BOTH sides for closed rings, so a target
    // near 0 or near 2π always finds a valid interpolation segment.
    let exA, exP;
    if (closed) {
        exA = [ang[n - 1] - 2 * Math.PI, ...ang, ang[0] + 2 * Math.PI];
        exP = [pts[n - 1],               ...pts, pts[0]];
    } else {
        exA = ang;
        exP = pts;
    }

    const steps = closed ? Nout : (Nout - 1);
    const span  = angMax - angMin;
    const out = [];
    for (let i = 0; i < Nout; i++) {
        const target = angMin + (i / steps) * span;
        // Largest lo s.t. exA[lo] <= target (exA is sorted ascending).
        let lo = 0;
        for (let j = 0; j < exA.length - 1; j++) {
            if (exA[j] <= target + 1e-12) lo = j; else break;
        }
        const hi = Math.min(lo + 1, exA.length - 1);
        const da = exA[hi] - exA[lo];
        const u  = da > 1e-12 ? (target - exA[lo]) / da : 0;
        out.push({
            x: exP[lo].x + u * (exP[hi].x - exP[lo].x),
            y: exP[lo].y + u * (exP[hi].y - exP[lo].y),
            // Z is interpolated too: with radial sagitta / arced horn the ring
            // is NOT planar, and pinning every sample to the first point's Z
            // would flatten the bend back out of the exported STEP/MSH.
            z: exP[lo].z + u * (exP[hi].z - exP[lo].z)
        });
    }
    return out;
}

/**
 * Compute the (angMin, angMax, Nresample) tuple for a given split mode.
 * These define the FIXED reference angles for re-sampling so every
 * cross-section uses identical control-point angles.
 */
function getResampleParams(split, hasSplit, N) {
    if (split && split.horizontal && split.vertical) {
        return { angMin: 0, angMax: Math.PI / 2, Nresample: Math.ceil(N / 4) + 1 };
    }
    if (hasSplit && split && split.horizontal) {
        return { angMin: 0, angMax: Math.PI, Nresample: Math.ceil(N / 2) + 1 };
    }
    if (hasSplit && split && split.vertical) {
        return { angMin: -Math.PI / 2, angMax: Math.PI / 2, Nresample: Math.ceil(N / 2) + 1 };
    }
    return { angMin: 0, angMax: 2 * Math.PI, Nresample: N };
}

/**
 * Extract cross-section slices from fullWaveguide, apply split filtering,
 * and apply the standard coordinate transform (translate + rotate -90° X).
 * Returns ordered 3D points per slice ready for .geo output.
 */
function extractSlicesForSTEP(geom, lastConfig, split) {
    const pos = geom.attributes.position;
    const N = lastConfig.numLines;
    const totalSlices = Math.floor(pos.count / N);
    const totalLength = getEffectiveTotalLength(lastConfig);
    const hasSplit = split.horizontal || split.vertical;
    // Detect when radial distortion or arced-horn curving is active — both
    // transforms perturb each vertex's Z independently, so the ring is no
    // longer planar in Z. We must preserve per-vertex Z to keep the bend in
    // the export (otherwise the BSpline collapses back to a flat ring and
    // radial/arced effects appear "bypassed").
    const radial = lastConfig.radial;
    const radialActive = !!(radial && radial.enabled &&
        ((radial.upDown && radial.upDown.height > 0) ||
         (radial.leftRight && radial.leftRight.height > 0)));
    const arcedActive = !!(lastConfig.arcedHorn && lastConfig.arcedHorn.enabled &&
        ((lastConfig.arcedHorn.upDown && lastConfig.arcedHorn.upDown.angle > 0) ||
         (lastConfig.arcedHorn.leftRight && lastConfig.arcedHorn.leftRight.angle > 0)));
    const preservePerVertexZ = radialActive || arcedActive;
    const slices = [];

    for (let i = 0; i < totalSlices; i++) {
        const points3D = [];
        const [, , ringZ] = getPreciseXYZ(geom, i * N);
        for (let j = 0; j < N; j++) {
            const idx = i * N + j;
            if (idx >= pos.count) break;
            const [x, y, vz] = getPreciseXYZ(geom, idx);
            if (split.horizontal && y < -0.001) continue;
            if (split.vertical && x < -0.001) continue;
            // XY = cross-section plane, Z = axial (throat at -totalLength, mouth at 0, faces +Z).
            // When radial/arced is OFF, snap to ringZ for clean planar BSplines (legacy behaviour).
            // When ON, keep the per-vertex Z so the bend / sagitta survives the export.
            const zOut = (preservePerVertexZ ? vz : ringZ) - totalLength;
            points3D.push({ x: x, y: y, z: zOut });
        }
        // Sort by angle.
        // - Split (open arc): atan2 gives a continuous range for the kept half.
        // - Full ring (closed): normalized [0, 2π) so every section starts at
        //   the rightmost point (angle≈0).
        if (hasSplit) {
            points3D.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
        } else {
            const na = p => { const a = Math.atan2(p.y, p.x); return a < 0 ? a + 2 * Math.PI : a; };
            points3D.sort((a, b) => na(a) - na(b));
        }
        // Dedup coincident points (DOSC pinAngle=0 collapses Nq pts → 1).
        const deduped = deduplicateRing(points3D);
        points3D.length = 0; points3D.push(...deduped);
        if (points3D.length < 3) continue;
        // SNAP BEFORE RESAMPLE: force endpoints onto the symmetry plane so
        // their atan2 values match the fixed reference angles exactly.
        if (hasSplit && points3D.length >= 2) {
            const n = points3D.length;
            if (split.horizontal && split.vertical) {
                points3D[0].y   = 0;   // first → atan2 = 0
                points3D[n-1].x = 0;   // last  → atan2 = π/2
            } else if (split.horizontal) {
                points3D[0].y   = 0;   // first → atan2 = 0
                points3D[n-1].y = 0;   // last  → atan2 = π
            } else if (split.vertical) {
                points3D[0].x   = 0;   // first → atan2 = -π/2
                points3D[n-1].x = 0;   // last  → atan2 = +π/2
            }
        }
        // Re-sample at FIXED reference angles so every section has control
        // points at the exact same angular positions → OCC ThruSections sees
        // perfectly compatible wires → loft is fold-free everywhere.
        const { angMin, angMax, Nresample } = getResampleParams(split, hasSplit, N);
        const resampled = uniformAngleSample(points3D, Nresample, angMin, angMax, !hasSplit);
        points3D.length = 0; points3D.push(...resampled);
        if (points3D.length >= 3) {
            slices.push({ points3D, origZ: ringZ });
        }
    }

    // -------- Symmetry snap (non-split only) --------
    // The renderer samples θ = 2πk/N around each ring. With a symmetric
    // profile the points are *mathematically* mirror-symmetric across the
    // X axis (y → −y, pairs i ↔ (N−i) mod N) and/or the Y axis
    // (x → −x, pairs i ↔ (N/2 − i) mod N), but `Math.cos/Math.sin` round
    // the supplementary angles independently, producing a sub-µm
    // asymmetry that BSpline interpolation faithfully preserves and CAD
    // viewers happily display ("the mouth isn't centered").
    //
    // We detect symmetry empirically per-ring (max deviation under a
    // tight tolerance) — if YES, average each pair to enforce exact
    // symmetry; if NO (intentionally asymmetric horn, e.g. offset mouth),
    // we leave the ring untouched.
    if (!hasSplit) {
        symmetrizeSlices(slices);
    }

    return slices;
}

/**
 * Snap each ring's vertices to exact X-axis and/or Y-axis symmetry when
 * the input is already symmetric to within SYM_TOL. Does not move points
 * for an intentionally asymmetric horn.
 */
function symmetrizeSlices(slices) {
    const SYM_TOL = 1e-3; // 1 µm — looser than fp noise, tighter than design intent
    if (slices.length === 0) return;
    const N = slices[0].points3D.length;
    if (N < 4) return;

    // Probe symmetry on every ring; only snap an axis if ALL rings are
    // symmetric across it (an asymmetric ring anywhere → leave all alone
    // for that axis to keep design intent intact).
    const checkAxis = (mirrorIndex /* (i)->j */, mirrorXY /* (p)->{x,y} */) => {
        for (const slice of slices) {
            const pts = slice.points3D;
            if (pts.length !== N) return false;
            for (let i = 0; i < N; i++) {
                const j = mirrorIndex(i);
                if (j < 0 || j >= N) return false;
                const m = mirrorXY(pts[j]);
                if (Math.abs(pts[i].x - m.x) > SYM_TOL) return false;
                if (Math.abs(pts[i].y - m.y) > SYM_TOL) return false;
            }
        }
        return true;
    };

    // X-axis symmetry: angle θ ↔ −θ ≡ 2π−θ, index i ↔ (N−i) mod N, mirror y.
    const symX = checkAxis(
        (i) => (N - i) % N,
        (p) => ({ x: p.x, y: -p.y })
    );
    // Y-axis symmetry: angle θ ↔ π−θ, index i ↔ ((N >> 1) - i + N) mod N, mirror x.
    const halfN = N >> 1;
    const symY = (N % 2 === 0) && checkAxis(
        (i) => ((halfN - i) % N + N) % N,
        (p) => ({ x: -p.x, y: p.y })
    );

    if (!symX && !symY) return;

    for (const slice of slices) {
        const pts = slice.points3D;
        // Apply X-axis snap: y_i := (y_i − y_{N−i})/2,  x_i := (x_i + x_{N−i})/2.
        if (symX) {
            const newPts = pts.map(p => ({ ...p }));
            for (let i = 0; i < N; i++) {
                const j = (N - i) % N;
                if (j < i) continue;
                const xa = (pts[i].x + pts[j].x) / 2;
                const ya = (pts[i].y - pts[j].y) / 2;
                if (i === j) {
                    newPts[i].x = xa;
                    newPts[i].y = 0; // self-mirror axis vertex
                } else {
                    newPts[i].x = xa; newPts[i].y =  ya;
                    newPts[j].x = xa; newPts[j].y = -ya;
                }
            }
            for (let i = 0; i < N; i++) { pts[i].x = newPts[i].x; pts[i].y = newPts[i].y; }
        }
        // Apply Y-axis snap: x_i := (x_i − x_{halfN−i})/2,  y_i := (y_i + y_{halfN−i})/2.
        if (symY) {
            const newPts = pts.map(p => ({ ...p }));
            const visited = new Array(N).fill(false);
            for (let i = 0; i < N; i++) {
                if (visited[i]) continue;
                const j = ((halfN - i) % N + N) % N;
                visited[i] = true; visited[j] = true;
                const xa = (pts[i].x - pts[j].x) / 2;
                const ya = (pts[i].y + pts[j].y) / 2;
                if (i === j) {
                    newPts[i].x = 0; // self-mirror axis vertex
                    newPts[i].y = ya;
                } else {
                    newPts[i].x =  xa; newPts[i].y = ya;
                    newPts[j].x = -xa; newPts[j].y = ya;
                }
            }
            for (let i = 0; i < N; i++) { pts[i].x = newPts[i].x; pts[i].y = newPts[i].y; }
        }
    }
}

/**
 * Returns true when radial sagitta or arced-horn bending is active and the
 * renderer has produced a `fullInterfaceWall` geometry that we can loft
 * through. Used to decide whether to switch the .geo's interface from a
 * straight Extrude to a curved loft.
 */
function shouldUseBentInterface(lastConfig, geoms) {
    if (!geoms || !geoms.fullInterfaceWall) return false;
    const radial = lastConfig && lastConfig.radial;
    const radialActive = !!(radial && radial.enabled &&
        ((radial.upDown && radial.upDown.height > 0) ||
         (radial.leftRight && radial.leftRight.height > 0)));
    const arced = lastConfig && lastConfig.arcedHorn;
    const arcedActive = !!(arced && arced.enabled &&
        ((arced.upDown && arced.upDown.angle > 0) ||
         (arced.leftRight && arced.leftRight.angle > 0)));
    return radialActive || arcedActive;
}

/**
 * Extract bent interface-wall ring slices from the renderer's
 * `fullInterfaceWall` geometry.
 */
function extractInterfaceWallSlices(geom, numLines, totalLength, split) {
    if (!geom || !geom.attributes?.position) return [];
    const pos = geom.attributes.position;
    const N = numLines;
    const totalSlices = Math.floor(pos.count / N);
    if (totalSlices < 2) return [];
    const hasSplit = !!(split && (split.horizontal || split.vertical));
    const slices = [];
    for (let i = 0; i < totalSlices; i++) {
        const points3D = [];
        for (let j = 0; j < N; j++) {
            const idx = i * N + j;
            if (idx >= pos.count) break;
            const x = pos.getX(idx);
            const y = pos.getY(idx);
            const vz = pos.getZ(idx);
            if (split && split.horizontal && y < -0.001) continue;
            if (split && split.vertical && x < -0.001) continue;
            // Interface wall is always per-vertex bent — preserve Z.
            points3D.push({ x, y, z: vz - totalLength });
        }
        // Same ordering / dedup / snap / resample pipeline as the horn slices:
        // ThruSections only produces a fold-free loft when EVERY wire has its
        // control points at the same reference angles.
        if (hasSplit) {
            points3D.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
        } else {
            const na = p => { const a = Math.atan2(p.y, p.x); return a < 0 ? a + 2 * Math.PI : a; };
            points3D.sort((a, b) => na(a) - na(b));
        }
        const deduped = deduplicateRing(points3D);
        points3D.length = 0; points3D.push(...deduped);
        if (points3D.length < 3) continue;
        if (hasSplit && points3D.length >= 2) {
            const n = points3D.length;
            if (split.horizontal && split.vertical) {
                points3D[0].y   = 0;
                points3D[n-1].x = 0;
            } else if (split.horizontal) {
                points3D[0].y   = 0;
                points3D[n-1].y = 0;
            } else if (split.vertical) {
                points3D[0].x   = 0;
                points3D[n-1].x = 0;
            }
        }
        const { angMin, angMax, Nresample } = getResampleParams(split, hasSplit, N);
        const resampled = uniformAngleSample(points3D, Nresample, angMin, angMax, !hasSplit);
        points3D.length = 0; points3D.push(...resampled);
        if (points3D.length >= 3) {
            slices.push({ points3D, origZ: pos.getZ(i * N) });
        }
    }
    return slices;
}

/**
 * Emit GMSH .geo scripting to remove a ThruSections solid's end caps,
 * keeping only the lateral surface.
 *
 * The lateral surface is identified by the largest bounding-box VOLUME, not
 * by Z extent: on a bent horn (radial sagitta / arced horn) the throat and
 * mouth caps are tilted planes with a large Z extent and the old dz criterion
 * kept a cap instead of the horn wall. The lateral surface always spans the
 * whole solid, so its bbox volume is strictly the largest.
 */
function emitCapRemoval(lines, volumeTag, prefix) {
    lines.push(`${prefix}bnd() = Boundary{ Volume{${volumeTag}}; };`);
    lines.push(`Delete{ Volume{${volumeTag}}; }`);
    lines.push(`${prefix}maxvol = -1; ${prefix}keep = 0;`);
    lines.push(`For ${prefix}i In {0 : #${prefix}bnd()-1}`);
    lines.push(`  ${prefix}tag = Abs(${prefix}bnd(${prefix}i));`);
    lines.push(`  ${prefix}bb() = BoundingBox Surface{${prefix}tag};`);
    lines.push(`  ${prefix}vol = (${prefix}bb(3)-${prefix}bb(0)) * (${prefix}bb(4)-${prefix}bb(1)) * (${prefix}bb(5)-${prefix}bb(2));`);
    lines.push(`  If (${prefix}vol > ${prefix}maxvol)`);
    lines.push(`    ${prefix}maxvol = ${prefix}vol; ${prefix}keep = ${prefix}i;`);
    lines.push(`  EndIf`);
    lines.push(`EndFor`);
    lines.push(`For ${prefix}i In {0 : #${prefix}bnd()-1}`);
    lines.push(`  If (${prefix}i != ${prefix}keep)`);
    lines.push(`    Recursive Delete{ Surface{Abs(${prefix}bnd(${prefix}i))}; }`);
    lines.push(`  EndIf`);
    lines.push(`EndFor`);
}

/**
 * Generate the complete .geo file for STEP/MSH export.
 *
 * The horn and the interface wall are ALWAYS lofted separately so that each
 * keeps its own physical tag; a single ThruSections through horn + wall rings
 * buried the interface contour inside `horn_surface`.
 *
 * Symmetry has two modes:
 *  - `preSplit = false` (default): full 360° rings are lofted, then the model
 *    is intersected with a half/quarter-space Box — gmsh performs the cut, and
 *    each group comes out as a single clean face.
 *  - `preSplit = true`: the caller already clipped the rings and they are
 *    closed with Lines on the symmetry planes. Required for bent horns (radial
 *    sagitta / arced horn): OCC silently refuses to boolean-cut the non-planar
 *    BSpline loft surfaces they produce and returns them whole.
 */
export function generateGeoForSTEPLoft(hornSlices, buildInterface, tipOffset, meshConfig, split, interfaceWallSlices, preSplit = false, interfaceFaceSlices = null) {
    if (meshConfig) meshConfig = normalizeMeshConfig(meshConfig);
    const hasSplit = !!(split && (split.horizontal || split.vertical));
    const cutInGmsh = hasSplit && !preSplit;
    const quarter = hasSplit && split.horizontal && split.vertical;
    const lines = ['SetFactory("OpenCASCADE");', ''];

    // --- Smooth single-surface loft ---
    // OCC ThruSections, when invoked from .geo as `ThruSections(N) = {wires}`,
    // is hard-coded to smoothing=false (gmsh parser). Without a high enough
    // approximation degree the lofter falls back to a series of low-order
    // patches that show up as visible iso-curve seams at every section level
    // when the STEP is reopened in another CAD.
    lines.push('Geometry.OCCThruSectionsDegree = 5;');
    lines.push('Geometry.Tolerance = 1e-6;');
    lines.push('');

    if (hornSlices.length < 2) return '// Not enough horn sections\n';

    // When a bend is active the renderer pre-bends the interface wall; its
    // first ring coincides with the horn mouth ring, so the wall is lofted from
    // those rings instead of being extruded straight along +Z (which would
    // punch through the bent horn body).
    const useLoftedInterface = !!(buildInterface && tipOffset > 0
        && interfaceWallSlices && interfaceWallSlices.length >= 2);
    // The interface FACE is lofted from the renderer's own concentric rings too.
    // Closing the bent mouth contour with an OCC `Surface` filling instead gave
    // a surface that hugs the mouth rather than the dome shown in the preview.
    const useLoftedFace = !!(useLoftedInterface
        && interfaceFaceSlices && interfaceFaceSlices.length >= 2);
    const rawSlices = useLoftedInterface
        ? hornSlices.concat(
            interfaceWallSlices.slice(1),
            useLoftedFace ? interfaceFaceSlices.slice(1) : [])
        : hornSlices;

    // A closed BSpline ring has a seam at its start point, and OCC splits the
    // lofted face in two when the symmetry cut leaves that seam inside the kept
    // region. Rotating every ring by the same index moves the seam into the
    // discarded part, so each group stays a single face.
    const seamAngle = !cutInGmsh ? 0
        : quarter ? 1.25 * Math.PI
        : split.horizontal ? 1.5 * Math.PI
        : Math.PI;
    const allSlices = seamAngle === 0 ? rawSlices : rawSlices.map(slice => {
        const n = slice.points3D.length;
        const k = Math.round(seamAngle / (2 * Math.PI) * n) % n;
        if (!k) return slice;
        return { ...slice, points3D: slice.points3D.slice(k).concat(slice.points3D.slice(0, k)) };
    });

    let xmin = Infinity, xmax = -Infinity;
    let ymin = Infinity, ymax = -Infinity;
    let zmin = Infinity, zmax = -Infinity;
    for (const s of allSlices) {
        for (const p of s.points3D) {
            if (p.x < xmin) xmin = p.x;
            if (p.x > xmax) xmax = p.x;
            if (p.y < ymin) ymin = p.y;
            if (p.y > ymax) ymax = p.y;
            if (p.z < zmin) zmin = p.z;
            if (p.z > zmax) zmax = p.z;
        }
    }
    if (buildInterface && tipOffset > 0 && !useLoftedInterface) zmax += tipOffset;
    const modelSize = Math.max(xmax - xmin, ymax - ymin, zmax - zmin, 1);
    const flatTol = (modelSize * 1e-4).toPrecision(4);

    // =================== Phase 1: Define ALL points ===========================
    let pointId = 1;
    const ranges = [];
    for (const slice of allSlices) {
        const first = pointId;
        for (const p of slice.points3D) {
            lines.push(`Point(${pointId}) = {${p.x.toFixed(6)}, ${p.y.toFixed(6)}, ${p.z.toFixed(6)}, 0};`);
            pointId++;
        }
        ranges.push({ first, count: slice.points3D.length });
    }
    const cornerPts = [];
    if (preSplit && quarter) {
        for (const s of allSlices) {
            const cp = pointId++;
            lines.push(`Point(${cp}) = {0, 0, ${s.points3D[0].z.toFixed(6)}, 0};`);
            cornerPts.push(cp);
        }
    }
    lines.push('');

    // =================== Phase 2: Curves per ring =============================
    let nextCurve = pointId + 10000;
    const ringCurves = [];

    const ringIsCircular = (slice) => {
        const pts = slice.points3D;
        if (pts.length < 4) return false;
        const r0 = Math.hypot(pts[0].x, pts[0].y);
        const z0 = pts[0].z;
        if (r0 < 1e-6) return false;
        const tol = Math.max(1e-4, r0 * 1e-5);
        for (const p of pts) {
            if (Math.abs(Math.hypot(p.x, p.y) - r0) > tol || Math.abs(p.z - z0) > tol) return false;
        }
        return true;
    };

    for (let si = 0; si < ranges.length; si++) {
        const r = ranges[si];
        const slice = allSlices[si];
        const cId = nextCurve++;
        // An OCC `Circle` is exact where a closed BSpline through N samples is
        // only accurate to ~R·pi²/(2N²) — but its seam is locked at angle 0,
        // which would drag the loft seam back into the kept region, so it is
        // only used on the uncut model.
        if (!hasSplit && ringIsCircular(slice)) {
            const radius = Math.hypot(slice.points3D[0].x, slice.points3D[0].y);
            lines.push(`Circle(${cId}) = {0, 0, ${slice.points3D[0].z.toFixed(6)}, ${radius.toFixed(6)}};`);
        } else {
            const pts = [];
            for (let j = 0; j < r.count; j++) pts.push(r.first + j);
            if (!preSplit) pts.push(r.first); // close the ring
            lines.push(`BSpline(${cId}) = {${pts.join(', ')}};`);
        }
        ringCurves.push(cId);
    }
    lines.push('');

    // =================== Phase 2b: Closing lines (pre-split only) =============
    const closing = [];
    if (preSplit) {
        for (let si = 0; si < ranges.length; si++) {
            const r = ranges[si];
            const firstPt = r.first;
            const lastPt = r.first + r.count - 1;
            const cls = [];
            if (quarter) {
                const l1 = nextCurve++, l2 = nextCurve++;
                lines.push(`Line(${l1}) = {${lastPt}, ${cornerPts[si]}};`);
                lines.push(`Line(${l2}) = {${cornerPts[si]}, ${firstPt}};`);
                cls.push(l1, l2);
            } else {
                const lId = nextCurve++;
                lines.push(`Line(${lId}) = {${lastPt}, ${firstPt}};`);
                cls.push(lId);
            }
            closing.push(cls);
        }
        lines.push('');
    }

    // =================== Phase 2c: Wires ======================================
    const mouthIdx = hornSlices.length - 1;
    // Last wall ring = first face ring (they are the same contour).
    const faceStartIdx = useLoftedFace
        ? mouthIdx + interfaceWallSlices.length - 1
        : ringCurves.length - 1;
    let nextWire = nextCurve + 100000;
    const ringOf = (i) => (preSplit ? [ringCurves[i], ...closing[i]] : [ringCurves[i]]);
    const wireFor = (i) => {
        const w = nextWire++;
        lines.push(`Wire(${w}) = {${ringOf(i).join(', ')}};`);
        return w;
    };
    const hornWires = [];
    for (let i = 0; i <= mouthIdx; i++) hornWires.push(wireFor(i));
    const wallWires = [];
    if (useLoftedInterface) for (let i = mouthIdx; i <= faceStartIdx; i++) wallWires.push(wireFor(i));
    const faceWires = [];
    if (useLoftedFace) for (let i = faceStartIdx; i < ringCurves.length; i++) faceWires.push(wireFor(i));
    lines.push('');

    const tagBase = nextWire + 100000;

    // =================== Phase 3: Lofts =======================================
    // OCC only closes a ThruSections into a solid when BOTH end wires are
    // planar. With a bent end ring it returns the lateral shell alone.
    const isPlanarRing = (slice) => {
        const z0 = slice.points3D[0].z;
        return slice.points3D.every(p => Math.abs(p.z - z0) <= 1e-4);
    };
    const throatPlanar = isPlanarRing(allSlices[0]);
    const mouthPlanar = isPlanarRing(allSlices[mouthIdx]);
    const ifaceEdgePlanar = isPlanarRing(allSlices[faceStartIdx]);
    const farPlanar = isPlanarRing(allSlices[allSlices.length - 1]);
    const hornSolid = throatPlanar && mouthPlanar;
    const wallSolid = useLoftedInterface && mouthPlanar && ifaceEdgePlanar;
    const faceSolid = useLoftedFace && ifaceEdgePlanar && farPlanar;

    // Pre-split lofts also produce the flat symmetry-plane faces; they are
    // detected by a zero-width bounding box on the cut axis and removed.
    const cutTests = [];
    if (preSplit && split.vertical) cutTests.push(`(_bb(3)-_bb(0)) < ${flatTol}`);
    if (preSplit && split.horizontal) cutTests.push(`(_bb(4)-_bb(1)) < ${flatTol}`);

    // Exposes <p>lat (lateral patch) and, for a solid loft, <p>tc / <p>mc (the
    // low-Z and high-Z caps). The surfaces a loft creates are found by diffing
    // `Surface{:}` around it: a non-solid ThruSections creates no volume to
    // take the Boundary{} of, and `news` does not track OCC tags.
    const emitLoft = (volTag, wires, isSolid, p) => {
        lines.push(`${p}pre() = Surface{:};`);
        lines.push(`${p}n0 = #${p}pre();`);
        lines.push(`ThruSections(${volTag}) = {${wires.join(', ')}};`);
        if (isSolid) lines.push(`Delete{ Volume{${volTag}}; }`);
        lines.push(`${p}post() = Surface{:};`);
        lines.push(`${p}lat = -1; ${p}mv = -1;`);
        // The lateral patch is the only 3D-curved one, hence the largest
        // bounding-box volume. Caps are flat but can be tilted on a bent horn,
        // so a plain Z-extent test would misclassify them.
        lines.push(`For _i In {${p}n0 : #${p}post()-1}`);
        lines.push(`  _bb() = BoundingBox Surface{${p}post(_i)};`);
        lines.push('  _cut = 0;');
        cutTests.forEach(t => lines.push(`  If (${t}) _cut = 1; EndIf`));
        lines.push('  If (_cut == 0)');
        lines.push('    _v = (_bb(3)-_bb(0)) * (_bb(4)-_bb(1)) * (_bb(5)-_bb(2));');
        lines.push(`    If (_v > ${p}mv) ${p}mv = _v; ${p}lat = ${p}post(_i); EndIf`);
        lines.push('  EndIf');
        lines.push('EndFor');
        lines.push(`${p}tc = -1; ${p}mc = -1; _mnz = 1e30; _mxz = -1e30;`);
        lines.push(`For _i In {${p}n0 : #${p}post()-1}`);
        lines.push(`  _s = ${p}post(_i);`);
        lines.push('  _bb() = BoundingBox Surface{_s};');
        lines.push('  _cut = 0;');
        cutTests.forEach(t => lines.push(`  If (${t}) _cut = 1; EndIf`));
        lines.push('  If (_cut == 1)');
        lines.push('    Recursive Delete{ Surface{_s}; }');
        lines.push('  EndIf');
        lines.push('  If (_cut == 0)');
        lines.push(`    If (_s != ${p}lat)`);
        lines.push('      _zm = (_bb(2) + _bb(5)) / 2;');
        lines.push(`      If (_zm < _mnz) _mnz = _zm; ${p}tc = _s; EndIf`);
        lines.push(`      If (_zm > _mxz) _mxz = _zm; ${p}mc = _s; EndIf`);
        lines.push('    EndIf');
        lines.push('  EndIf');
        lines.push('EndFor');
        lines.push('');
    };

    lines.push('// --- Horn loft (throat → mouth) ---');
    emitLoft(1, hornWires, hornSolid, '_h');
    if (useLoftedInterface) {
        lines.push('// --- Interface wall loft (mouth → interface plane) ---');
        emitLoft(1001, wallWires, wallSolid, '_w');
    }
    if (useLoftedFace) {
        lines.push('// --- Interface face loft (interface edge → centre) ---');
        emitLoft(1002, faceWires, faceSolid, '_f');
    }

    // =================== Phase 4: Caps + surface groups =======================
    const groups = [{ name: 'horn_surface', expr: '_hlat' }];
    const emitCap = (ringIdx, planar, tagLoop, tagSurf) => {
        lines.push(`Curve Loop(${tagLoop}) = {${ringOf(ringIdx).join(', ')}};`);
        lines.push(planar
            ? `Plane Surface(${tagSurf}) = {${tagLoop}};`
            : `Surface(${tagSurf}) = {${tagLoop}};`);
        return `${tagSurf}`;
    };
    const farIdx = ringCurves.length - 1;

    if (buildInterface) {
        groups.push({
            name: 'throat_cap',
            expr: hornSolid ? '_htc' : emitCap(0, throatPlanar, tagBase, tagBase + 1),
        });

        if (useLoftedInterface) {
            groups.push({ name: 'interface_wall', expr: '_wlat' });
            if (useLoftedFace) {
                // Lofted rings + the small central plug, both tagged as the face.
                const plug = faceSolid ? '_fmc' : emitCap(farIdx, farPlanar, tagBase + 4, tagBase + 5);
                groups.push({ name: 'interface_face', expr: `_flat, ${plug}` });
            } else {
                groups.push({
                    name: 'interface_face',
                    expr: wallSolid ? '_wmc' : emitCap(farIdx, farPlanar, tagBase + 4, tagBase + 5),
                });
            }
        } else if (tipOffset > 0) {
            lines.push('// --- Interface wall + face (straight extrusion) ---');
            lines.push(`_iw[] = Extrude {0, 0, ${tipOffset.toFixed(6)}} { Curve{${ringCurves[farIdx]}}; };`);
            if (preSplit) {
                // The extruded arc is open: close it on the symmetry plane(s).
                lines.push('_fEnds() = Boundary{ Curve{_iw[0]}; };');
                if (quarter) {
                    // `Extrude` already consumed the point tags right after the
                    // ring points, so the axis point is taken from the reserved
                    // high range instead of `pointId`.
                    const far = tagBase + 30;
                    const zIface = (allSlices[farIdx].points3D[0].z + tipOffset).toFixed(6);
                    lines.push(`Point(${far}) = {0, 0, ${zIface}, 0};`);
                    lines.push(`Line(${tagBase + 20}) = {_fEnds(1), ${far}};`);
                    lines.push(`Line(${tagBase + 21}) = {${far}, _fEnds(0)};`);
                    lines.push(`Curve Loop(${tagBase + 22}) = {_iw[0], ${tagBase + 20}, ${tagBase + 21}};`);
                } else {
                    lines.push(`Line(${tagBase + 20}) = {_fEnds(1), _fEnds(0)};`);
                    lines.push(`Curve Loop(${tagBase + 22}) = {_iw[0], ${tagBase + 20}};`);
                }
            } else {
                lines.push(`Curve Loop(${tagBase + 22}) = {_iw[0]};`);
            }
            lines.push(`Surface(${tagBase + 23}) = {${tagBase + 22}};`);
            groups.push({ name: 'interface_wall', expr: '_iw[1]' });
            groups.push({ name: 'interface_face', expr: `${tagBase + 23}` });
        } else {
            groups.push({
                name: 'mouth_cap',
                expr: hornSolid ? '_hmc' : emitCap(farIdx, farPlanar, tagBase + 4, tagBase + 5),
            });
        }
    }

    // Drop the loft caps that belong to no group: the internal horn↔wall
    // junction, the cap replaced by the extruded interface, and both caps when
    // the interface is disabled.
    const deadCaps = [];
    if (hornSolid) {
        if (!buildInterface) deadCaps.push('_htc');
        if (!buildInterface || useLoftedInterface || tipOffset > 0) deadCaps.push('_hmc');
    }
    if (wallSolid) {
        deadCaps.push('_wtc');
        if (useLoftedFace) deadCaps.push('_wmc');
    }
    if (faceSolid) deadCaps.push('_ftc');
    deadCaps.forEach(v => lines.push(`Recursive Delete{ Surface{${v}}; }`));
    lines.push('');

    // =================== Phase 5: Symmetry cut (performed by OCC) =============
    // Keep x>=0 for a vertical split and y>=0 for a horizontal one — the same
    // convention the renderer uses.
    if (cutInGmsh) {
        const pad = modelSize * 2 + 10;
        const bx = split.vertical ? 0 : xmin - pad;
        const bdx = split.vertical ? xmax + pad : (xmax - xmin) + 2 * pad;
        const by = split.horizontal ? 0 : ymin - pad;
        const bdy = split.horizontal ? ymax + pad : (ymax - ymin) + 2 * pad;
        const bz = zmin - pad;
        const bdz = (zmax - zmin) + 2 * pad;
        const boxTag = 2;

        lines.push('// --- Symmetry cut (full model intersected with a half/quarter space) ---');
        lines.push(`Box(${boxTag}) = {${bx.toFixed(6)}, ${by.toFixed(6)}, ${bz.toFixed(6)}, ${bdx.toFixed(6)}, ${bdy.toFixed(6)}, ${bdz.toFixed(6)}};`);
        groups.forEach((g, i) => {
            const dropTool = i === groups.length - 1 ? ' Delete;' : '';
            lines.push(`_g${i}() = BooleanIntersection{ Surface{${g.expr}}; Delete; }{ Volume{${boxTag}};${dropTool} };`);
        });
    } else {
        groups.forEach((g, i) => lines.push(`_g${i}() = {${g.expr}};`));
    }
    lines.push('');

    // =================== Phase 6: Physical Surfaces + mesh sizing =============
    if (meshConfig) {
        lines.push('// --- Physical Surfaces for BEM ---');
        groups.forEach((g, i) => lines.push(`Physical Surface("${g.name}") = {_g${i}()};`));
        lines.push('');

        lines.push('// --- Mesh parameters ---');
        let throatCurveIds = null;
        if (meshConfig.horn.adaptive) {
            // The boolean cut renumbers the throat curve, so resolve it at
            // .geo runtime: lowest-Z boundary curve of the horn surface.
            lines.push('_hb() = Boundary{ Surface{_g0()}; };');
            lines.push('_thrIdx = 0; _thrZ = 1e30;');
            lines.push('For _i In {0 : #_hb()-1}');
            lines.push('  _cb() = BoundingBox Curve{Abs(_hb(_i))};');
            lines.push('  _cz = (_cb(2) + _cb(5)) / 2;');
            lines.push('  If (_cz < _thrZ)');
            lines.push('    _thrZ = _cz; _thrIdx = _i;');
            lines.push('  EndIf');
            lines.push('EndFor');
            throatCurveIds = ['Abs(_hb(_thrIdx))'];
        }
        const hornLength = Math.abs(
            hornSlices[hornSlices.length - 1].points3D[0].z - hornSlices[0].points3D[0].z
        );
        // Each physical surface keeps its own clmax via a dedicated Restrict
        // field (see emitGroupSizeField) instead of MeshSize{PointsOf{...}},
        // which used to leak the smallest clmax into neighbouring surfaces
        // through Gmsh's default boundary-size extension.
        let fieldId = 1;
        const bgFieldIds = [];
        groups.forEach((group, index) => {
            if (group.name === 'horn_surface') {
                const { fieldId: hornFieldId, nextFieldId } =
                    emitMeshSizingLines(lines, meshConfig.horn, throatCurveIds, hornLength, fieldId, `_g${index}()`);
                fieldId = nextFieldId;
                bgFieldIds.push(hornFieldId);
                return;
            }
            const profile = group.name === 'throat_cap' ? meshConfig.source : meshConfig.interface;
            const { fieldId: groupFieldId, nextFieldId } =
                emitGroupSizeField(lines, profile.clmax, `_g${index}()`, fieldId);
            fieldId = nextFieldId;
            bgFieldIds.push(groupFieldId);
        });
        const minId = fieldId;
        lines.push(`Field[${minId}] = Min;`);
        lines.push(`Field[${minId}].FieldsList = {${bgFieldIds.join(', ')}};`);
        lines.push(`Background Field = ${minId};`);
        // Disable boundary-size extension: sizes must stay local to the
        // surface each Restrict field targets, not bleed into neighbours.
        lines.push('Mesh.CharacteristicLengthExtendFromBoundary = 0;');
        lines.push(`Mesh.CharacteristicLengthMax = ${Math.max(meshConfig.source.clmax, meshConfig.horn.clmax, meshConfig.interface.clmax)};`); // safety cap
        lines.push(`Mesh.MeshSizeFromCurvature = ${meshConfig.curvature};`);
        lines.push('Mesh.Algorithm = 6;'); // Frontal-Delaunay
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * For DOSC mode, the combined `fullWaveguide` geometry concatenates shell + body
 * + interface, which has no consistent axial slice structure. We use the clean
 * shell-only buffer (uniform Nax+1 × Nang grid) and synthesise the missing
 * `numLines` / `segments` keys so `extractSlicesForSTEP` works unchanged.
 * Returns `{ geom, cfg }` ready for the standard pipeline.
 *
 * Les cotes viennent de `doscMeta`, PAS de `lastConfig.dosc` : `numLines` y est
 * le vrai compte (multiple de 4 recalculé par `generateDosc`) et `depth` existe,
 * là où `dosc.numLines` / `dosc.length` n'ont jamais existé et tombaient
 * silencieusement sur 64 / 244, décalant tous les anneaux.
 */
function resolveExportSource(geoms, lastConfig) {
    if (geoms.doscShell && lastConfig.dosc) {
        const meta   = geoms.doscMeta || {};
        const Nang   = +meta.numLines || +lastConfig.numLines || 64;
        const length = +meta.depth    || +lastConfig.dosc.depth || 244;
        const cfg = {
            ...lastConfig,
            numLines: Nang,
            segments: [{ length }],
            throatAdapter: null,
        };
        return { geom: geoms.doscShell, cfg };
    }
    return { geom: geoms.fullWaveguide, cfg: lastConfig };
}

/**
 * Extract DOSC body slices (rings of Nang points) from the body geometry.
 * The body mesh is `Nrings_body × Nang` ring vertices followed by 2 cap
 * centroids (added by ringsToCappedMesh). Each ring is at a single Z.
 * We snap all points in a ring to the same Z so BSpline stays planar, and
 * skip rings whose half-axes are below `minHalfMm` (apex / edge degeneracies)
 * because lofting through them creates singularities.
 * When `split` is active, points outside the kept quadrant(s) are dropped and
 * the remaining points are sorted by angle for clean open curves.
 */
function extractDoscBodySlices(bodyGeom, lastConfig, totalLength, split) {
    if (!bodyGeom || !bodyGeom.attributes?.position) return [];
    const pos = bodyGeom.attributes.position;
    const Nang = +lastConfig.numLines || 64;
    const Nrings = Math.floor((pos.count - 2) / Nang);
    // With degree=2, tolerance=1e-4 and max 25 sections, OCC handles thin rings
    // reliably. Keep thresholds close to REAR_EDGE_THK (0.3 mm) so the apex and
    // edge-14 extremities stay in the loft and match the 3D preview.
    const minHalfMm = 0.5;   // skip only truly point-degenerate apex rings (< 0.5 mm)
    const minWidthMm = 0.5;  // reject rings fully collapsed onto an axis (< 0.5 mm wide)
    const hasSplit = split && (split.horizontal || split.vertical);
    const slices = [];
    for (let i = 0; i < Nrings; i++) {
        const points3D = [];
        const z = pos.getZ(i * Nang);
        let maxHalf = 0;
        let xmin =  Infinity, xmax = -Infinity, ymin =  Infinity, ymax = -Infinity;
        for (let j = 0; j < Nang; j++) {
            const idx = i * Nang + j;
            const x = pos.getX(idx);
            const y = pos.getY(idx);
            if (split?.horizontal && y < -0.001) continue;
            if (split?.vertical   && x < -0.001) continue;
            maxHalf = Math.max(maxHalf, Math.abs(x), Math.abs(y));
            if (x < xmin) xmin = x; if (x > xmax) xmax = x;
            if (y < ymin) ymin = y; if (y > ymax) ymax = y;
            points3D.push({ x, y, z: z - totalLength });
        }
        if (maxHalf < minHalfMm) continue; // skip degenerate apex/edge rings
        // Reject rings collapsed onto a single axis (e.g. aBevel→0 near the mouth
        // produces an x≡0 vertical line — the patent's edge "14" — which is not
        // a valid closed loft section for OCC ThruSections).
        if ((xmax - xmin) < minWidthMm || (ymax - ymin) < minWidthMm) continue;
        if (hasSplit) {
            points3D.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
        } else {
            const na = p => { const a = Math.atan2(p.y, p.x); return a < 0 ? a + 2 * Math.PI : a; };
            points3D.sort((a, b) => na(a) - na(b));
        }
        const deduped = deduplicateRing(points3D);
        points3D.length = 0; points3D.push(...deduped);
        if (points3D.length < 3) continue;
        // SNAP BEFORE RESAMPLE — endpoints sit exactly on the snap-plane angles.
        if (hasSplit && points3D.length >= 2) {
            const n = points3D.length;
            if (split.horizontal && split.vertical) {
                points3D[0].y   = 0;
                points3D[n-1].x = 0;
            } else if (split.horizontal) {
                points3D[0].y   = 0;
                points3D[n-1].y = 0;
            } else if (split.vertical) {
                points3D[0].x   = 0;
                points3D[n-1].x = 0;
            }
        }
        const { angMin, angMax, Nresample } = getResampleParams(split, hasSplit, Nang);
        const resampled = uniformAngleSample(points3D, Nresample, angMin, angMax, !hasSplit);
        points3D.length = 0; points3D.push(...resampled);
        if (points3D.length >= 3) slices.push({ points3D, origZ: z });
    }
    if (!hasSplit) symmetrizeSlices(slices);
    return slices;
}

/**
 * Emit a .geo file with TWO ThruSections lofts (shell + body), optional
 * mouth interface (extruded ring + flat face), and full split support
 * (closing lines + classification of horn / throat / mouth surfaces).
 * Used in DOSC mode.
 */
export function generateGeoForDoscLoft(shellSlices, bodySlices, buildInterface, tipOffset, meshConfig, split, NangBody) {
    const hasSplit = !!(split && (split.horizontal || split.vertical));
    const quarter  = hasSplit && split.horizontal && split.vertical;
    const lines = ['SetFactory("OpenCASCADE");', ''];
    // Degree 3 = smooth cubic loft across all sections (C2 continuity).
    // Earlier versions used degree 1 because higher-degree lofts oscillated at
    // the s=0.5 topology change (pure ellipse → bevel-clipped).  That was a
    // *parameterisation* problem — section A's control point k sat at a
    // different angle than section B's k — and it has now been fixed in
    // extract*Slices*() by re-sampling every ring at FIXED reference angles.
    // With identical angular layout for all sections, OCC has truly compatible
    // wires and a cubic loft produces a tangent-continuous fold-free surface.
    lines.push('Geometry.OCCThruSectionsDegree = 3;');
    lines.push('Geometry.Tolerance = 1e-4;');
    lines.push('');
    if (shellSlices.length < 2) return '// Not enough shell sections\n';

    let pointId = 1;

    const emitSlicePoints = (slices) => {
        const ranges = [];
        for (const slice of slices) {
            const first = pointId;
            for (const p of slice.points3D) {
                lines.push(`Point(${pointId}) = {${p.x.toFixed(6)}, ${p.y.toFixed(6)}, ${p.z.toFixed(6)}, 0};`);
                pointId++;
            }
            ranges.push({ first, count: slice.points3D.length });
        }
        return ranges;
    };
    const shellRanges = emitSlicePoints(shellSlices);
    const bodyRanges  = bodySlices.length >= 2 ? emitSlicePoints(bodySlices) : [];

    // Quarter-split corner points (origin axis) per slice
    const shellCorners = [];
    const bodyCorners  = [];
    if (quarter) {
        for (const s of shellSlices) {
            const cp = pointId++;
            lines.push(`Point(${cp}) = {0, 0, ${s.points3D[0].z.toFixed(6)}, 0};`);
            shellCorners.push(cp);
        }
        for (const s of bodySlices) {
            const cp = pointId++;
            lines.push(`Point(${cp}) = {0, 0, ${s.points3D[0].z.toFixed(6)}, 0};`);
            bodyCorners.push(cp);
        }
    }
    lines.push('');

    let nextCurve = pointId + 10000;

    // Detect perfectly-circular rings (e.g. the shell throat).  For those we
    // emit an OCC `Circle` primitive instead of a Spline approximation — the
    // analytic circle preserves the user's throat diameter to machine
    // precision (no R·π²/(2N²) sampling error from a Spline through N points).
    const ringIsCircular = (slice) => {
        const pts = slice.points3D;
        if (pts.length < 4) return false;
        const r0 = Math.hypot(pts[0].x, pts[0].y);
        const z0 = pts[0].z;
        if (r0 < 1e-6) return false;
        const tol = Math.max(1e-4, r0 * 1e-5);
        for (const p of pts) {
            if (Math.abs(Math.hypot(p.x, p.y) - r0) > tol || Math.abs(p.z - z0) > tol) return false;
        }
        return true;
    };

    const buildBSplines = (ranges, slices) => {
        const ids = [];
        for (let si = 0; si < ranges.length; si++) {
            const r     = ranges[si];
            const slice = slices[si];
            if (!hasSplit && ringIsCircular(slice)) {
                const radius = Math.hypot(slice.points3D[0].x, slice.points3D[0].y);
                const zr     = slice.points3D[0].z;
                const cId    = nextCurve++;
                lines.push(`Circle(${cId}) = {0, 0, ${zr.toFixed(6)}, ${radius.toFixed(6)}};`);
                ids.push(cId);
                continue;
            }
            const pts = [];
            for (let j = 0; j < r.count; j++) pts.push(r.first + j);
            if (!hasSplit) pts.push(r.first); // close ring
            const cId = nextCurve++;
            // Spline interpolates EXACTLY through every control point.
            // BSpline only approximates → small deviations would create
            // tiny radial mismatches between adjacent sections that the
            // loft surface picks up as visible ridges/striations.
            lines.push(`Spline(${cId}) = {${pts.join(', ')}};`);
            ids.push(cId);
        }
        return ids;
    };
    const shellBSplines = buildBSplines(shellRanges, shellSlices);
    // Body uses the same per-ring curve approach.  Body rings are never
    // perfectly circular (apex disk is a small disk only at z=APEX_OFFSET,
    // and even there ringIsCircular would catch it and emit a Circle).
    const bodyBSplines = bodyRanges.length >= 2 ? buildBSplines(bodyRanges, bodySlices) : [];
    lines.push('');

    // Closing lines (split mode only)
    const buildClosing = (ranges, corners) => {
        const closings = [];
        for (let si = 0; si < ranges.length; si++) {
            const r = ranges[si];
            const firstPt = r.first;
            const lastPt  = r.first + r.count - 1;
            const cls = [];
            if (quarter) {
                const l1 = nextCurve++, l2 = nextCurve++;
                lines.push(`Line(${l1}) = {${lastPt}, ${corners[si]}};`);
                lines.push(`Line(${l2}) = {${corners[si]}, ${firstPt}};`);
                cls.push(l1, l2);
            } else {
                const lId = nextCurve++;
                lines.push(`Line(${lId}) = {${lastPt}, ${firstPt}};`);
                cls.push(lId);
            }
            closings.push(cls);
        }
        return closings;
    };
    const shellClosings = hasSplit ? buildClosing(shellRanges, shellCorners) : [];
    // Body closings: only the cut-plane line(s) are needed when split (the body
    // arcs already meet at the rhombus corners). For non-split, no closing needed.
    const bodyClosings  = hasSplit ? buildClosing(bodyRanges,  bodyCorners)  : [];
    if (hasSplit) lines.push('');

    let nextWire = nextCurve + 100000;
    const buildWires = (bsplines, closings) => bsplines.map((b, i) => {
        const w = nextWire++;
        const curves = hasSplit ? [b, ...closings[i]] : [b];
        lines.push(`Wire(${w}) = {${curves.join(', ')}};`);
        return w;
    });
    const shellWires = buildWires(shellBSplines, shellClosings);
    const bodyWires  = bodyBSplines.length >= 2 ? buildWires(bodyBSplines, bodyClosings) : [];
    lines.push('');

    const tagBase = nextWire + 100000;

    // Helper: lateral-surface classification (split mode) for a ThruSections volume.
    // Strategy: the curved "horn" surface is the only 3D-curved patch — its
    // bounding-box VOLUME (dx*dy*dz) is non-zero. All other surfaces are flat:
    // cut planes (dx≈0 or dy≈0), throat cap (dz≈0 at low z), mouth cap (dz≈0
    // at high z). Selecting by max bbox volume reliably keeps only the horn.
    const emitSplitClassify = (volTag, prefix, keepThroatVar = null, keepMouthVar = null) => {
        lines.push(`${prefix}bnd() = Boundary{ Volume{${volTag}}; };`);
        lines.push(`Delete{ Volume{${volTag}}; }`);
        lines.push(`${prefix}horn = 0; ${prefix}maxvol = -1;`);
        lines.push(`For ${prefix}i In {0 : #${prefix}bnd()-1}`);
        lines.push(`  ${prefix}bb() = BoundingBox Surface{Abs(${prefix}bnd(${prefix}i))};`);
        lines.push(`  ${prefix}vol = (${prefix}bb(3)-${prefix}bb(0)) * (${prefix}bb(4)-${prefix}bb(1)) * (${prefix}bb(5)-${prefix}bb(2));`);
        lines.push(`  If (${prefix}vol > ${prefix}maxvol)`);
        lines.push(`    ${prefix}maxvol = ${prefix}vol; ${prefix}horn = ${prefix}i;`);
        lines.push(`  EndIf`);
        lines.push(`EndFor`);
        if (keepThroatVar) {
            // Throat cap: flat (dz≈0) with the lowest z mid-point
            lines.push(`${prefix}throat = -1; ${prefix}tz = 1e30;`);
            lines.push(`For ${prefix}i In {0 : #${prefix}bnd()-1}`);
            lines.push(`  If (${prefix}i != ${prefix}horn)`);
            lines.push(`    ${prefix}bb() = BoundingBox Surface{Abs(${prefix}bnd(${prefix}i))};`);
            lines.push(`    ${prefix}dz = ${prefix}bb(5) - ${prefix}bb(2);`);
            lines.push(`    ${prefix}zm = (${prefix}bb(5) + ${prefix}bb(2)) / 2;`);
            lines.push(`    If (${prefix}dz < 1e-3)`);
            lines.push(`      If (${prefix}zm < ${prefix}tz)`);
            lines.push(`        ${prefix}tz = ${prefix}zm; ${prefix}throat = ${prefix}i;`);
            lines.push(`      EndIf`);
            lines.push(`    EndIf`);
            lines.push(`  EndIf`);
            lines.push(`EndFor`);
        }
        if (keepMouthVar) {
            lines.push(`${prefix}mouth = -1; ${prefix}mz = -1e30;`);
            lines.push(`For ${prefix}i In {0 : #${prefix}bnd()-1}`);
            lines.push(`  If (${prefix}i != ${prefix}horn)`);
            lines.push(`    ${prefix}bb() = BoundingBox Surface{Abs(${prefix}bnd(${prefix}i))};`);
            lines.push(`    ${prefix}dz = ${prefix}bb(5) - ${prefix}bb(2);`);
            lines.push(`    ${prefix}zm = (${prefix}bb(5) + ${prefix}bb(2)) / 2;`);
            lines.push(`    If (${prefix}dz < 1e-3)`);
            lines.push(`      If (${prefix}zm > ${prefix}mz)`);
            lines.push(`        ${prefix}mz = ${prefix}zm; ${prefix}mouth = ${prefix}i;`);
            lines.push(`      EndIf`);
            lines.push(`    EndIf`);
            lines.push(`  EndIf`);
            lines.push(`EndFor`);
        }
        // Delete every surface except horn (and optionally throat/mouth)
        lines.push(`For ${prefix}i In {#${prefix}bnd()-1 : 0 : -1}`);
        lines.push(`  If (${prefix}i != ${prefix}horn)`);
        if (keepThroatVar) lines.push(`    If (${prefix}i != ${prefix}throat)`);
        if (keepMouthVar)  lines.push(`      If (${prefix}i != ${prefix}mouth)`);
        lines.push(`        Delete{ Surface{Abs(${prefix}bnd(${prefix}i))}; }`);
        if (keepMouthVar)  lines.push(`      EndIf`);
        if (keepThroatVar) lines.push(`    EndIf`);
        lines.push(`  EndIf`);
        lines.push(`EndFor`);
    };

    // ===== Shell loft =====
    lines.push('// --- Shell loft ---');
    lines.push(`ThruSections(1) = {${shellWires.join(', ')}};`);
    if (hasSplit) {
        const keepThroat = !!buildInterface;
        const keepMouth  = buildInterface && tipOffset === 0; // no interface => keep mouth as cap
        emitSplitClassify(1, '_h', keepThroat, keepMouth);
    } else {
        emitCapRemoval(lines, 1, '_h');
    }
    lines.push('');

    // ===== Body loft =====
    let bodyHasLoft = false;
    if (bodyWires.length >= 2) {
        bodyHasLoft = true;
        lines.push('// --- Body loft (Heil V-DOSC inner diamond) ---');
        lines.push(`ThruSections(2) = {${bodyWires.join(', ')}};`);
        if (hasSplit) {
            emitSplitClassify(2, '_b', false, false);
        } else {
            emitCapRemoval(lines, 2, '_b');
        }
        lines.push('');
    }

    // ===== Interface (mouth flange + flat face) =====
    let ifaceWallVar = null;
    let ifaceFaceTag = null;
    let throatCapTag = null;
    if (buildInterface) {
        if (!hasSplit) {
            lines.push('// --- Throat cap (source) ---');
            lines.push(`Curve Loop(${tagBase}) = {${shellBSplines[0]}};`);
            lines.push(`Plane Surface(${tagBase + 1}) = {${tagBase}};`);
            throatCapTag = tagBase + 1;
            lines.push('');
        }
        if (tipOffset > 0) {
            const lastShell = shellBSplines[shellBSplines.length - 1];
            lines.push('// --- Interface wall (extrude mouth ring) ---');

            // Quarter mode: pre-emit the far origin point so we can close the face
            let farCornerPt = -1;
            if (quarter) {
                const mouthZ = shellSlices[shellSlices.length - 1].points3D[0].z;
                const ifaceZ = mouthZ + tipOffset;
                farCornerPt = pointId++;
                lines.push(`Point(${farCornerPt}) = {0, 0, ${ifaceZ.toFixed(6)}, 0};`);
            }
            lines.push(`_iw[] = Extrude {0, 0, ${tipOffset.toFixed(6)}} { Curve{${lastShell}}; };`);
            ifaceWallVar = '_iw[1]';
            lines.push('');

            lines.push('// --- Interface face (flat cap at the front) ---');
            if (hasSplit) {
                lines.push('_fEnds() = Boundary{ Curve{_iw[0]}; };');
                if (quarter) {
                    lines.push(`Line(${tagBase + 20}) = {_fEnds(1), ${farCornerPt}};`);
                    lines.push(`Line(${tagBase + 21}) = {${farCornerPt}, _fEnds(0)};`);
                    lines.push(`Curve Loop(${tagBase + 22}) = {_iw[0], ${tagBase + 20}, ${tagBase + 21}};`);
                    lines.push(`Surface(${tagBase + 23}) = {${tagBase + 22}};`);
                    ifaceFaceTag = tagBase + 23;
                } else {
                    lines.push(`Line(${tagBase + 20}) = {_fEnds(1), _fEnds(0)};`);
                    lines.push(`Curve Loop(${tagBase + 21}) = {_iw[0], ${tagBase + 20}};`);
                    lines.push(`Surface(${tagBase + 22}) = {${tagBase + 21}};`);
                    ifaceFaceTag = tagBase + 22;
                }
            } else {
                lines.push(`Curve Loop(${tagBase + 2}) = {_iw[0]};`);
                lines.push(`Surface(${tagBase + 3}) = {${tagBase + 2}};`);
                ifaceFaceTag = tagBase + 3;
            }
            lines.push('');
        }
    }

    // ===== Physical Surfaces + mesh sizing =====
    if (meshConfig) {
        // Les autres exportateurs normalisent en amont, mais cette fonction est
        // aussi appelée directement (harnais, anciens appels) avec la forme
        // « plate » historique { clmax, curvature } — dépourvue des profils
        // source/horn/interface lus plus bas. `normalizeMeshConfig` gère
        // explicitement cette forme et est idempotent sur une config déjà
        // normalisée : l'appliquer ici ne change rien pour l'application.
        meshConfig = normalizeMeshConfig(meshConfig);
        lines.push('// --- Physical Surfaces for BEM ---');
        const groups = [];
        groups.push({
            name: 'horn_surface',
            expr: hasSplit ? 'Abs(_hbnd(_hhorn))' : 'Abs(_hbnd(_hkeep))',
            profile: meshConfig.horn,
        });
        if (bodyHasLoft) {
            groups.push({
                name: 'body_surface',
                expr: hasSplit ? 'Abs(_bbnd(_bhorn))' : 'Abs(_bbnd(_bkeep))',
                profile: meshConfig.horn,
            });
        }
        if (buildInterface) {
            if (hasSplit) {
                groups.push({ name: 'throat_cap', expr: 'Abs(_hbnd(_hthroat))', profile: meshConfig.source });
            } else if (throatCapTag) {
                groups.push({ name: 'throat_cap', expr: throatCapTag, profile: meshConfig.source });
            }
            if (ifaceWallVar) groups.push({ name: 'interface_wall', expr: ifaceWallVar, profile: meshConfig.interface });
            if (ifaceFaceTag) groups.push({ name: 'interface_face', expr: ifaceFaceTag, profile: meshConfig.interface });
            if (hasSplit && tipOffset === 0) {
                groups.push({ name: 'mouth_cap', expr: 'Abs(_hbnd(_hmouth))', profile: meshConfig.interface });
            }
        }
        groups.forEach(g => lines.push(`Physical Surface("${g.name}") = {${g.expr}};`));
        lines.push('');
        lines.push('// --- Mesh parameters ---');
        // Each group keeps its own clmax via a Constant field scoped by its own
        // SurfacesList (see emitGroupSizeField in the STEP-loft path above for
        // why a flat Mesh.CharacteristicLengthMax would collapse everything to
        // the smallest source/horn/interface value).
        let fieldId = 1;
        const bgFieldIds = [];
        groups.forEach(g => {
            const { fieldId: gid, nextFieldId } = emitGroupSizeField(lines, g.profile.clmax, g.expr, fieldId);
            fieldId = nextFieldId;
            bgFieldIds.push(gid);
        });
        const minId = fieldId;
        lines.push(`Field[${minId}] = Min;`);
        lines.push(`Field[${minId}].FieldsList = {${bgFieldIds.join(', ')}};`);
        lines.push(`Background Field = ${minId};`);
        lines.push(`Mesh.CharacteristicLengthMax = ${Math.max(meshConfig.source.clmax, meshConfig.horn.clmax, meshConfig.interface.clmax)};`); // safety cap
        if (meshConfig.curvature != null) {
            lines.push(`Mesh.MeshSizeFromCurvature = ${meshConfig.curvature};`);
        }
        lines.push('Mesh.Algorithm = 6;');
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Candidats .geo par ordre de préférence.
 * En DOSC on construit d'abord la géométrie en B-Rep exact (cône + plans +
 * congé OCC) ; le loft par sections ne reste qu'en repli, au cas où OCC
 * échouerait à poser le congé sur l'arête de pli.
 */
function buildGeoCandidates({
    geoms, lastConfig, srcCfg, geom, isDosc, split,
    buildInterface, tipOffset, maxSections, meshConfig,
}) {
    const candidates = [];

    if (isDosc) {
        const meta = geoms.doscMeta;
        if (meta && meta.params) {
            const brep = generateGeoForDoscBRep({
                params: meta.params,
                filletRadius: meta.filletRadius,
                edgeThickness: meta.edgeThickness,
                noseRadius: meta.noseRadius,
                buildInterface,
                tipOffset,
                meshConfig,
                split,
            });
            if (brep) candidates.push({ label: 'B-Rep', geo: brep });
        }
    }

    // Symétrie : le pavillon droit est loft en anneaux COMPLETS puis coupé par
    // un booléen OCC (une seule face par groupe). Un pavillon cintré (radial /
    // arced) produit des surfaces BSpline non planes qu'OCC refuse de couper —
    // il est alors découpé côté JS, en demi-anneaux fermés par des Lines.
    const NO_SPLIT = { horizontal: false, vertical: false };
    const hasSplit = !!(split.horizontal || split.vertical);
    const bent = !isDosc && shouldUseBentInterface(lastConfig, geoms);
    const preSplit = hasSplit && bent;
    const extractSplit = (isDosc || preSplit) ? split : NO_SPLIT;

    const allHornSlices = extractSlicesForSTEP(geom, srcCfg, extractSplit);
    // OCC ThruSections dégénère (lent + sections invalides) au-delà de ~30 coupes :
    // le temps de loft croît de façon très non linéaire (≈20 s à 100 coupes contre
    // ~1 s à 30), pour un gain de fidélité nul sur un profil lisse.
    const DOSC_MAX_SECTIONS = 40;
    const LOFT_MAX_SECTIONS = 30;
    const target = maxSections > 0 ? maxSections
        : isDosc ? Math.min(allHornSlices.length, DOSC_MAX_SECTIONS)
        : Math.min(allHornSlices.length, LOFT_MAX_SECTIONS);
    const hornSlices = selectKeySlices(allHornSlices, target);

    if (isDosc) {
        const totalLength = srcCfg.segments[0].length;
        const allBodySlices = extractDoscBodySlices(geoms.doscBody, srcCfg, totalLength, split);
        const bodySlices = selectKeySlices(allBodySlices, target);
        candidates.push({
            label: 'loft',
            geo: generateGeoForDoscLoft(hornSlices, bodySlices, buildInterface, tipOffset, meshConfig, split, srcCfg.numLines),
        });
    } else {
        // Bend radial/arqué actif : le renderer a produit une paroi d'interface
        // courbe, on lofte ses anneaux au lieu d'un Extrude droit.
        // On ne garde que 3 anneaux : la paroi est quasi droite, et empiler ses
        // ~10 sections quasi identiques derrière celles du pavillon fait
        // dégénérer OCC ThruSections.
        let ifaceWallSlices = null;
        let ifaceFaceSlices = null;
        if (bent) {
            const totalLength = getEffectiveTotalLength(lastConfig);
            const allWall = extractInterfaceWallSlices(
                geoms.fullInterfaceWall, lastConfig.numLines, totalLength, extractSplit);
            if (allWall.length >= 2) ifaceWallSlices = selectKeySlices(allWall, 3);
            // La face d'interface est loftée depuis les anneaux concentriques du
            // renderer : la refermer par un `Surface` OCC produisait un cône qui
            // rentrait vers l'axe au lieu du plan visible dans l'aperçu.
            const allFace = extractInterfaceWallSlices(
                geoms.fullInterfaceFace, lastConfig.numLines, totalLength, extractSplit);
            if (ifaceWallSlices && allFace.length >= 2) ifaceFaceSlices = selectKeySlices(allFace, 4);
        }
        candidates.push({
            label: 'loft',
            geo: generateGeoForSTEPLoft(hornSlices, buildInterface, tipOffset, meshConfig, split, ifaceWallSlices, preSplit, ifaceFaceSlices),
        });
        if (ifaceFaceSlices) {
            // Repli si OCC n'arrive pas à lofter la face : paroi loftée + face
            // fermée par un remplissage.
            candidates.push({
                label: 'loft (face remplie)',
                geo: generateGeoForSTEPLoft(hornSlices, buildInterface, tipOffset, meshConfig, split, ifaceWallSlices, preSplit, null),
            });
        }
        if (ifaceWallSlices) {
            // Repli si OCC n'arrive pas à lofter la paroi courbe : pavillon
            // cintré + interface extrudée droite (moins fidèle mais robuste).
            candidates.push({
                label: 'loft (interface droite)',
                geo: generateGeoForSTEPLoft(hornSlices, buildInterface, tipOffset, meshConfig, split, null, preSplit),
            });
        }
    }

    return candidates;
}

export async function exportSTEP(getGeometries, lastConfig, buildInterface, maxSections, exportButton) {
    const geoms = getGeometries();
    const { geom, cfg: srcCfg } = resolveExportSource(geoms, lastConfig);
    if (!geom || !geom.attributes.position) return;

    const showStatus = (msg, isError = false) => {
        if (!exportButton) return;
        const orig = exportButton.textContent;
        exportButton.textContent = msg;
        exportButton.classList.toggle('text-red-400', isError);
        exportButton.classList.toggle('text-green-400', !isError);
        setTimeout(() => { exportButton.textContent = orig; exportButton.classList.remove('text-red-400', 'text-green-400'); }, 4000);
    };

    const settings = await getSettings();
    const gmshPath = settings.paths?.gmsh;
    if (!gmshPath) { showStatus('GMSH path missing!', true); return; }

    const basePath = settings.paths.dataRoot ? `${settings.paths.dataRoot}\\STEP-out` : '';
    if (!basePath) { showStatus('Path missing!', true); return; }

    const split = lastConfig.split || { horizontal: false, vertical: false };
    const isDosc = !!(geoms.doscShell && lastConfig.dosc);
    // In DOSC mode, prefer the DOSC-tab tip offset; lastConfig.interface.tipOffset
    // retains the legacy waveguide-tab default (30mm) and would otherwise mask
    // the user's DOSC value.
    const tipOffset = isDosc
        ? (lastConfig.dosc?.interfaceTipOffset ?? lastConfig.interface?.tipOffset ?? 0)
        : (lastConfig.interface?.tipOffset ?? 0);

    // Extract slices with split filtering (open curves for split, full for non-split)
    const tGeo = performance.now();
    const candidates = buildGeoCandidates({
        geoms, lastConfig, srcCfg, geom, isDosc, split,
        buildInterface, tipOffset, maxSections, meshConfig: null,
    });
    const dtGeo = performance.now() - tGeo;

    const tDir = performance.now();
    const outputDir = await getNextNumberedFolder(basePath, 'waveguide');
    const dtDir = performance.now() - tDir;
    const fileName = 'waveguide.step';

    let result = null;
    const gmshTimes = [];
    for (let ci = 0; ci < candidates.length; ci++) {
        showStatus(ci === 0 ? 'Lofting...' : `Retry (${candidates[ci].label})...`, false);
        const t0 = performance.now();
        result = await window.electronAPI.exportWaveguideStep({
            gmshPath,
            geoContent: candidates[ci].geo,
            outputDir,
            fileName,
            debugLabel: `c${ci}_${candidates[ci].label}`
        });
        gmshTimes.push(`${candidates[ci].label}=${((performance.now() - t0) / 1000).toFixed(1)}s`);
        if (result.success) break;
        console.warn(`STEP export: candidate "${candidates[ci].label}" failed:`, result.error);
    }
    console.info(`STEP timing: geo=${(dtGeo / 1000).toFixed(1)}s dir=${(dtDir / 1000).toFixed(1)}s gmsh[${gmshTimes.join(' ')}]`);

    if (result.success) {
        const folderName = outputDir.split('\\').pop();
        showStatus(`STEP → ${folderName}`);
        return true;
    } else {
        const errMsg = (result.error || '').substring(0, 200);
        console.error('STEP export error:', result.error);
        showStatus(`STEP Error: ${errMsg}`, true);
        return false;
    }
}

export async function exportMSHDelaunay(getGeometries, lastConfig, buildInterface, maxSections, meshSettings, exportButton) {
    const showStatus = (msg, isError = false) => {
        if (!exportButton) return;
        const orig = exportButton.textContent;
        exportButton.textContent = msg;
        exportButton.classList.toggle('text-red-400', isError);
        exportButton.classList.toggle('text-green-400', !isError);
        setTimeout(() => { exportButton.textContent = orig; exportButton.classList.remove('text-red-400', 'text-green-400'); }, 4000);
    };

    try {
    const geoms = getGeometries();
    const { geom, cfg: srcCfg } = resolveExportSource(geoms, lastConfig);
    if (!geom || !geom.attributes.position) { showStatus('No geometry!', true); return false; }

    const settings = await getSettings();
    const gmshPath = settings.paths?.gmsh;
    if (!gmshPath) { showStatus('GMSH path missing!', true); return; }

    const basePath = settings.paths.dataRoot ? `${settings.paths.dataRoot}\\Mesh-out` : '';
    if (!basePath) { showStatus('Path missing!', true); return; }

    const split = lastConfig.split || { horizontal: false, vertical: false };
    const isDosc = !!(geoms.doscShell && lastConfig.dosc);
    const tipOffset = isDosc
        ? (lastConfig.dosc?.interfaceTipOffset ?? lastConfig.interface?.tipOffset ?? 0)
        : (lastConfig.interface?.tipOffset ?? 0);

    // Extract slices with split filtering (open curves for split, full for non-split)
    const meshConfig = normalizeMeshConfig(meshSettings);
    const tGeo = performance.now();
    const candidates = buildGeoCandidates({
        geoms, lastConfig, srcCfg, geom, isDosc, split,
        buildInterface, tipOffset, maxSections, meshConfig,
    });
    const dtGeo = performance.now() - tGeo;

    const fileName = 'waveguide_delaunay.msh';

    let result = null;
    const gmshTimes = [];
    for (let ci = 0; ci < candidates.length; ci++) {
        showStatus(ci === 0 ? 'Meshing...' : `Retry (${candidates[ci].label})...`, false);
        const t0 = performance.now();
        result = await window.electronAPI.exportWaveguideStep({
            gmshPath,
            geoContent: candidates[ci].geo,
            outputDir: basePath,
            fileName,
            mode: 'mesh',
            debugLabel: `c${ci}_${candidates[ci].label}`
        });
        gmshTimes.push(`${candidates[ci].label}=${((performance.now() - t0) / 1000).toFixed(1)}s`);
        if (result.success) break;
        console.warn(`MSH export: candidate "${candidates[ci].label}" failed:`, result.error);
    }
    console.info(`MSH timing: geo=${(dtGeo / 1000).toFixed(1)}s gmsh[${gmshTimes.join(' ')}]`);

    if (result.success) {
        showStatus('MSH → Mesh-out');
        return true;
    } else {
        const errMsg = (result.error || '').substring(0, 200);
        console.error('MSH Delaunay export error:', result.error);
        showStatus(`MSH Error: ${errMsg}`, true);
        return false;
    }
    } catch (e) {
        console.error('MSH Delaunay JS error:', e);
        showStatus(`JS Error: ${e.message}`, true);
        return false;
    }
}

export async function generateMSHForBEM(getGeometries, lastConfig, meshSettings = {}) {
    const geoms = typeof getGeometries === 'function' ? getGeometries() : getGeometries;
    const { geom, cfg: srcCfg } = resolveExportSource(geoms, lastConfig);
    if (!geom || !geom.attributes.position) throw new Error('No waveguide geometry available.');

    const settings = await getSettings();
    const gmshPath = settings.paths?.gmsh;
    if (!gmshPath) throw new Error('GMSH path is not configured.');

    const split = lastConfig.split || { horizontal: false, vertical: false };
    const isDosc = !!(geoms.doscShell && lastConfig.dosc);
    const tipOffset = isDosc
        ? (lastConfig.dosc?.interfaceTipOffset ?? lastConfig.interface?.tipOffset ?? 0)
        : (lastConfig.interface?.tipOffset ?? 0);
    const meshConfig = normalizeMeshConfig(meshSettings);
    const candidates = buildGeoCandidates({
        geoms, lastConfig, srcCfg, geom, isDosc, split,
        buildInterface: true, tipOffset, maxSections: 0, meshConfig,
    });

    let lastError = 'GMSH failed to generate the solver mesh.';
    for (const candidate of candidates) {
        const result = await window.electronAPI.exportWaveguideStep({
            gmshPath,
            geoContent: candidate.geo,
            fileName: 'waveguide_solver.msh',
            mode: 'mesh',
            returnContent: true,
        });
        if (result.success && result.content) {
            return { mshContent: result.content, meshMeta: { ...meshConfig, candidate: candidate.label } };
        }
        lastError = result.error || lastError;
        console.warn(`Solver mesh: candidate "${candidate.label}" failed:`, result.error);
    }
    throw new Error(lastError);
}

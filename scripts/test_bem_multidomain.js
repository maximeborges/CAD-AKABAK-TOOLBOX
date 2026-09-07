// =======================================================
// FICHIER :  test_bem_multidomain.js
// RÔLE    :  Script de test automatique pour le solveur BEM multi-domaine
//            Génère un .msh, lance le solveur, compare avec Akabak
// =======================================================

import { MultiDomainBEMSolver, generatePolarPlotData, generateContourPlotData } from '../src/js/bem/bemMultiDomainBackend.js';
import { createPolarPlot, createContourPlot } from '../src/js/bem/bemMultiDomainVisualizer.js';

// Ancré sur la racine du dépôt : le script restait sinon dépendant du dossier
// depuis lequel on l'invoquait.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const TEST_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test_data');
import * as fs from 'fs';
import * as path from 'path';

/**
 * Test 1: Parse MSH file
 */
async function testParseMSH() {
  console.log('\n=== Test 1: Parse MSH File ===');
  
  const mshPath = join(TEST_DATA_DIR, 'waveguide_default.msh');
  
  if (!fs.existsSync(mshPath)) {
    console.error(`❌ MSH file not found: ${mshPath}`);
    console.log('Please generate a .msh file from Waveguide Studio first.');
    console.log('Steps:');
    console.log('1. Open Waveguide Studio');
    console.log('2. Generate default waveguide');
    console.log('3. Check: Show Interface, Split H, Split V');
    console.log('4. Export .msh with: Mesh Max 15mm, Curvature 5mm');
    console.log('5. Save to test_data/waveguide_default.msh');
    return null;
  }
  
  const mshContent = fs.readFileSync(mshPath, 'utf-8');
  
  try {
    // Import the parser directly
    const { parseMSH } = await import('../src/js/bem/bemMultiDomainCore.js');
    const meshData = parseMSH(mshContent);
    
    console.log(`✓ Nodes: ${meshData.numNodes}`);
    console.log(`✓ Elements: ${meshData.numElements}`);
    console.log(`✓ Surfaces:`);
    for (const surf of meshData.surfaces) {
      console.log(`  - ${surf.name}: ${surf.triangles.length} triangles`);
    }
    
    return mshContent;
  } catch (err) {
    console.error(`❌ Parse error: ${err.message}`);
    return null;
  }
}

/**
 * Test 2: Solve single frequency
 */
async function testSingleFrequency(mshContent) {
  console.log('\n=== Test 2: Solve Single Frequency ===');
  
  if (!mshContent) {
    console.error('❌ No MSH content available');
    return null;
  }
  
  const solver = new MultiDomainBEMSolver();
  
  const startTime = Date.now();
  
  try {
    const result = await solver.solveMSH(mshContent, {
      freqs: [2000],
      distance_m: 10,
      angleStep: 5,
      angleMax: 90,
      onProgress: (ev) => {
        if (ev.phase === 'solve') {
          console.log(`  Solving: ${(ev.subProgress * 100).toFixed(0)}%`);
        }
      }
    });
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✓ Solved in ${elapsed}s`);
    console.log(`✓ Interior elements: ${result.meshInfo.subdomains.interior.length}`);
    console.log(`✓ Exterior elements: ${result.meshInfo.subdomains.exterior.length}`);
    console.log(`✓ Interface elements: ${result.meshInfo.subdomains.interface.length}`);
    
    const polarData = generatePolarPlotData(result, 2000, 'H');
    console.log(`✓ Polar data generated: ${polarData.angles.length} angles`);
    
    solver.terminate();
    return result;
  } catch (err) {
    console.error(`❌ Solve error: ${err.message}`);
    solver.terminate();
    return null;
  }
}

/**
 * Test 3: Solve frequency sweep
 */
async function testFrequencySweep(mshContent) {
  console.log('\n=== Test 3: Solve Frequency Sweep ===');
  
  if (!mshContent) {
    console.error('❌ No MSH content available');
    return null;
  }
  
  const solver = new MultiDomainBEMSolver();
  const freqs = [1000, 2000, 3000, 4000, 5000];
  
  const startTime = Date.now();
  let lastFreq = 0;
  
  try {
    const result = await solver.solveMSH(mshContent, {
      freqs,
      distance_m: 10,
      angleStep: 2,
      angleMax: 90,
      onProgress: (ev) => {
        if (ev.phase === 'freqDone' && ev.freq !== lastFreq) {
          lastFreq = ev.freq;
          console.log(`  ✓ ${ev.freq} Hz completed in ${ev.elapsed_ms.toFixed(0)} ms`);
        }
      }
    });
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✓ Sweep completed in ${elapsed}s`);
    console.log(`✓ Average time per frequency: ${(elapsed / freqs.length).toFixed(2)}s`);
    
    solver.terminate();
    return result;
  } catch (err) {
    console.error(`❌ Sweep error: ${err.message}`);
    solver.terminate();
    return null;
  }
}

/**
 * Test 4: Compare with Akabak
 */
async function testAkabakComparison(bemResult) {
  console.log('\n=== Test 4: Compare with Akabak ===');
  
  if (!bemResult) {
    console.error('❌ No BEM result available');
    return;
  }
  
  // Try to load Akabak reference data
  const akabakPath = join(TEST_DATA_DIR, 'akabak_reference_2000hz.csv');
  
  if (!fs.existsSync(akabakPath)) {
    console.log('⚠ Akabak reference data not found');
    console.log('To compare with Akabak:');
    console.log('1. Run the same simulation in Akabak');
    console.log('2. Export polar data at 2000 Hz (format: angle,dB)');
    console.log(`3. Save to ${akabakPath}`);
    return;
  }
  
  const akabakContent = fs.readFileSync(akabakPath, 'utf-8');
  const akabakData = parseAkabakData(akabakContent);
  
  console.log(`✓ Loaded ${akabakData.length} Akabak data points`);
  
  const bemPolar = generatePolarPlotData(bemResult, 2000, 'H');
  
  // Calculate comparison statistics
  let rmse = 0;
  let maxError = 0;
  let count = 0;
  
  for (let i = 0; i < bemPolar.angles.length; i++) {
    const angle = bemPolar.angles[i];
    const bemDB = bemPolar.dB[i];
    
    const akabakPoint = akabakData.find(p => Math.abs(p.angle - angle) < 0.5);
    if (akabakPoint) {
      const error = Math.abs(bemDB - akabakPoint.dB);
      rmse += error * error;
      maxError = Math.max(maxError, error);
      count++;
    }
  }
  
  rmse = count > 0 ? Math.sqrt(rmse / count) : 0;
  
  console.log(`✓ RMSE: ${rmse.toFixed(3)} dB`);
  console.log(`✓ Max Error: ${maxError.toFixed(3)} dB`);
  console.log(`✓ Compared ${count} points`);
  
  if (rmse < 1.0) {
    console.log('✅ Excellent agreement with Akabak!');
  } else if (rmse < 3.0) {
    console.log('✅ Good agreement with Akabak');
  } else {
    console.log('⚠ Large discrepancy with Akabak - check mesh and parameters');
  }
}

/**
 * Test 5: Performance benchmarks
 */
async function testPerformance(mshContent) {
  console.log('\n=== Test 5: Performance Benchmarks ===');
  
  if (!mshContent) {
    console.error('❌ No MSH content available');
    return;
  }
  
  const solver = new MultiDomainBEMSolver();
  
  // Test different element counts
  const tests = [
    { freq: 1000, name: 'Low frequency (1 kHz)' },
    { freq: 3000, name: 'Mid frequency (3 kHz)' },
    { freq: 5000, name: 'High frequency (5 kHz)' }
  ];
  
  console.log('Testing solve time vs frequency:\n');
  
  for (const test of tests) {
    const startTime = Date.now();
    
    try {
      await solver.solveMSH(mshContent, {
        freqs: [test.freq],
        distance_m: 10,
        angleStep: 5,
        angleMax: 90,
        onProgress: () => {} // Silent
      });
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`  ${test.name}: ${elapsed}s`);
    } catch (err) {
      console.error(`  ❌ ${test.name}: ${err.message}`);
    }
  }
  
  solver.terminate();
}

/**
 * Parse Akabak CSV data
 */
function parseAkabakData(text) {
  const lines = text.trim().split('\n');
  const data = [];
  
  for (const line of lines) {
    const parts = line.trim().split(/[,\s\t]+/);
    if (parts.length >= 2) {
      const angle = parseFloat(parts[0]);
      const dB = parseFloat(parts[1]);
      if (!isNaN(angle) && !isNaN(dB)) {
        data.push({ angle, dB });
      }
    }
  }
  
  return data;
}

/**
 * Main test runner
 */
async function runAllTests() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║  BEM Multi-Domain Solver - Test Suite    ║');
  console.log('╚═══════════════════════════════════════════╝');
  
  // Create test_data directory if it doesn't exist
  if (!fs.existsSync(TEST_DATA_DIR)) {
    fs.mkdirSync(TEST_DATA_DIR);
  }
  
  // Run tests
  const mshContent = await testParseMSH();
  
  if (mshContent) {
    const singleResult = await testSingleFrequency(mshContent);
    const sweepResult = await testFrequencySweep(mshContent);
    
    if (sweepResult) {
      await testAkabakComparison(sweepResult);
    }
    
    await testPerformance(mshContent);
  }
  
  console.log('\n═══════════════════════════════════════════');
  console.log('Test suite completed!');
  console.log('═══════════════════════════════════════════\n');
}

// Run tests if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export { runAllTests };

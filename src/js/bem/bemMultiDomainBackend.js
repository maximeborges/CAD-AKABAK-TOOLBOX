// =======================================================
// FICHIER :  src/js/bem/bemMultiDomainBackend.js
// RÔLE    :  Interface backend pour le solveur BEM multi-domaine
//            Gère le worker et fournit une API simple
// =======================================================

'use strict';

export class MultiDomainBEMSolver {
  constructor() {
    this.worker = null;
    this.currentJobId = 0;
    this.jobs = new Map();
  }

  /**
   * Initialize the worker
   */
  async initWorker() {
    if (this.worker) return Promise.resolve();
    
    return new Promise((resolve, reject) => {
      // Try to load worker from file
      fetch('./js/bem/bemMultiDomainWorker.js')
        .then(r => r.text())
        .then(code => {
          const blob = new Blob([code], { type: 'application/javascript' });
          const workerUrl = URL.createObjectURL(blob);
          this.worker = new Worker(workerUrl);
          
          this.worker.onmessage = (e) => {
            const msg = e.data;
            const job = this.jobs.get(msg.id);
            if (!job) return;
            
            if (msg.type === 'progress' && job.onProgress) {
              job.onProgress(msg.ev);
            } else if (msg.type === 'done') {
              job.resolve(msg.result);
              this.jobs.delete(msg.id);
            } else if (msg.type === 'error') {
              job.reject(new Error(msg.message));
              this.jobs.delete(msg.id);
            }
          };
          
          this.worker.onerror = (err) => {
            console.error('Worker error:', err);
            reject(err);
          };
          
          resolve();
        })
        .catch(err => {
          console.error('Failed to load worker:', err);
          reject(err);
        });
    });
  }

  /**
   * Solve BEM from .msh file content
   * @param {string} mshContent - Content of .msh file
   * @param {object} options - Solver options
   * @returns {Promise} Resolves with results
   */
  async solveMSH(mshContent, options = {}) {
    if (!this.worker) {
      await this.initWorker();
      // Laisse le worker s'installer avant le premier postMessage.
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return new Promise((resolve, reject) => {
      const id = ++this.currentJobId;
      
      this.jobs.set(id, {
        resolve,
        reject,
        onProgress: options.onProgress
      });
      
      this.worker.postMessage({
        type: 'compute',
        id,
        mshContent,
        opts: {
          freqs: options.freqs || [1000, 2000, 3000, 4000, 5000],
          distance_m: options.distance_m || 10,
          angleStep: options.angleStep || 2,
          angleMax: options.angleMax || 90
        }
      });
    });
  }

  /**
   * Abort a running computation
   */
  abort(jobId) {
    if (this.worker) {
      this.worker.postMessage({ type: 'abort', id: jobId });
    }
    this.jobs.delete(jobId);
  }

  /**
   * Terminate worker
   */
  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.jobs.clear();
  }
}

/**
 * Load .msh file from disk
 */
export async function loadMSHFile(filePath) {
  try {
    const result = await window.electronAPI.readFile(filePath);
    if (result.success) {
      return result.content;
    } else {
      throw new Error(`Failed to read file: ${result.error}`);
    }
  } catch (err) {
    console.error('Error loading MSH file:', err);
    throw err;
  }
}

/**
 * Generate polar plot data for visualization
 */
export function generatePolarPlotData(result, frequency, plane = 'H') {
  const polarData = plane === 'H' ? result.polarH : result.polarV;
  const freqData = polarData.find(p => Math.abs(p.f - frequency) < 0.1);
  
  if (!freqData) return null;
  
  const angles = freqData.angles;
  const normalized = freqData.normalized;
  
  // Convert to dB
  const dB = normalized.map(n => 20 * Math.log10(Math.max(n, 1e-10)));
  
  return {
    angles,
    normalized,
    dB,
    frequency
  };
}

/**
 * Generate contour plot data (frequency vs angle)
 */
export function generateContourPlotData(result, plane = 'H') {
  const polarData = plane === 'H' ? result.polarH : result.polarV;
  
  if (!polarData || polarData.length === 0) return null;
  
  const frequencies = polarData.map(p => p.f);
  const angles = polarData[0].angles;
  
  // Build 2D array: [freq][angle] = dB
  const data = polarData.map(p => {
    return p.normalized.map(n => 20 * Math.log10(Math.max(n, 1e-10)));
  });
  
  return {
    frequencies,
    angles,
    data
  };
}

/**
 * Compare with Akabak reference data
 */
export function compareWithAkabak(bemResult, akabakData, frequency, plane = 'H') {
  const bemPolar = generatePolarPlotData(bemResult, frequency, plane);
  if (!bemPolar) return null;
  
  // Calculate RMSE and max error
  let rmse = 0;
  let maxError = 0;
  let count = 0;
  
  for (let i = 0; i < bemPolar.angles.length; i++) {
    const angle = bemPolar.angles[i];
    const bemDB = bemPolar.dB[i];
    
    // Find corresponding Akabak data point
    const akabakPoint = akabakData.find(p => Math.abs(p.angle - angle) < 0.5);
    if (akabakPoint) {
      const error = Math.abs(bemDB - akabakPoint.dB);
      rmse += error * error;
      maxError = Math.max(maxError, error);
      count++;
    }
  }
  
  rmse = count > 0 ? Math.sqrt(rmse / count) : 0;
  
  return {
    rmse,
    maxError,
    count
  };
}

/**
 * Feature registry — the only place features are stored.
 * Features import registerFeature from here; app.js reads getFeatures.
 * No circular dependency.
 */

const features = []

/**
 * Register a feature module.
 * @param {{ id, name, category, icon, description, render, canRun?, run? }} feature
 */
export function registerFeature(feature) {
  if (features.find(f => f.id === feature.id)) {
    console.warn(`Feature "${feature.id}" already registered — skipping.`)
    return
  }
  features.push(feature)
}

export function getFeatures()    { return [...features] }
export function getFeature(id)   { return features.find(f => f.id === id) ?? null }

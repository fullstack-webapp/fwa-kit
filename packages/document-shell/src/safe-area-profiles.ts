export type SafeAreaCompatibilityProfile = {
  id: string
  platform: 'ios' | 'android'
  minimumRuntimeVersion: readonly [major: number, minor: number]
  displayMode: 'standalone' | 'browser'
  orientation: 'portrait' | 'landscape'
  screen: {
    width: number
    height: number
  }
  devicePixelRatio: number
  reserve: {
    bottom: number
  }
  maturity: 'candidate' | 'provisional' | 'verified' | 'established'
  rollout: 'probe' | 'referenceProduction' | 'consumerOptIn' | 'sharedDefault'
}

// This private catalog is package-owned. The public root projects only
// sharedDefault entries; the explicit reference subpath additionally projects
// referenceProduction entries for the source application that supplied their
// current evidence. Consumers do not select or redefine individual profiles.
export const safeAreaCompatibilityProfiles = [
  // Provisional entries come from the iOS 26.5 Simulator S2-S5 matrix recorded
  // in Base's Document Shell platform-extraction plan. The verified reference
  // entry additionally has repeated real-device video + trace evidence.
  {
    id: 'ios-375x812-3x-portrait-standalone',
    platform: 'ios',
    minimumRuntimeVersion: [26, 0],
    displayMode: 'standalone',
    orientation: 'portrait',
    screen: { width: 375, height: 812 },
    devicePixelRatio: 3,
    reserve: { bottom: 34 },
    maturity: 'provisional',
    rollout: 'referenceProduction',
  },
  {
    id: 'ios-393x852-3x-portrait-standalone',
    platform: 'ios',
    minimumRuntimeVersion: [26, 0],
    displayMode: 'standalone',
    orientation: 'portrait',
    screen: { width: 393, height: 852 },
    devicePixelRatio: 3,
    reserve: { bottom: 34 },
    maturity: 'provisional',
    rollout: 'referenceProduction',
  },
  {
    id: 'ios-402x874-3x-portrait-standalone',
    platform: 'ios',
    minimumRuntimeVersion: [26, 0],
    displayMode: 'standalone',
    orientation: 'portrait',
    screen: { width: 402, height: 874 },
    devicePixelRatio: 3,
    reserve: { bottom: 34 },
    maturity: 'verified',
    rollout: 'sharedDefault',
  },
  {
    id: 'ios-430x932-3x-portrait-standalone',
    platform: 'ios',
    minimumRuntimeVersion: [26, 0],
    displayMode: 'standalone',
    orientation: 'portrait',
    screen: { width: 430, height: 932 },
    devicePixelRatio: 3,
    reserve: { bottom: 34 },
    maturity: 'provisional',
    rollout: 'referenceProduction',
  },
] satisfies SafeAreaCompatibilityProfile[]

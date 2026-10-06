export default [
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly', requestAnimationFrame: 'readonly',
        performance: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', self: 'readonly', Worker: 'readonly', Event: 'readonly', indexedDB: 'readonly', URL: 'readonly', Blob: 'readonly', Image: 'readonly',
        MediaRecorder: 'readonly', MediaStream: 'readonly', AudioContext: 'readonly', OfflineAudioContext: 'readonly',
        ResizeObserver: 'readonly', getComputedStyle: 'readonly', Node: 'readonly', prompt: 'readonly',
        confirm: 'readonly', innerWidth: 'readonly', innerHeight: 'readonly', console: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none' }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
    },
  },
];

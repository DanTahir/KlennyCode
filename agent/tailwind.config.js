/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        klenny: {
          bg: '#0f1115',
          panel: '#161922',
          panel2: '#1d212c',
          border: '#2a2f3d',
          accent: '#f0a84b',
          accent2: '#e8863c',
          text: '#e6e8ef',
          muted: '#9aa1b2'
        }
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace']
      }
    }
  },
  plugins: []
}

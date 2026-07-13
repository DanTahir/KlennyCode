import typography from '@tailwindcss/typography'

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
      },
      typography: {
        invert: {
          css: {
            '--tw-prose-body': '#e6e8ef',
            '--tw-prose-headings': '#f0a84b',
            '--tw-prose-lead': '#e6e8ef',
            '--tw-prose-links': '#f0a84b',
            '--tw-prose-bold': '#e6e8ef',
            '--tw-prose-counters': '#9aa1b2',
            '--tw-prose-bullets': '#9aa1b2',
            '--tw-prose-hr': '#2a2f3d',
            '--tw-prose-quotes': '#e6e8ef',
            '--tw-prose-quote-borders': '#2a2f3d',
            '--tw-prose-captions': '#9aa1b2',
            '--tw-prose-code': '#f0a84b',
            '--tw-prose-pre-code': '#e6e8ef',
            '--tw-prose-pre-bg': '#111827',
            '--tw-prose-th-borders': '#2a2f3d',
            '--tw-prose-td-borders': '#2a2f3d',
            maxWidth: 'none'
          }
        }
      }
    }
  },
  plugins: [typography]
}

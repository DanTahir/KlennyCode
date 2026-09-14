import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        corgi: {
          orange: '#E8863A',
          'orange-soft': '#F2A968',
          'orange-deep': '#C96A22',
          cream: '#FBF3E7',
          dark: '#241A12',
          ink: '#0f0b08',
          'ink-soft': '#17100a',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['var(--font-display)', 'var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        'fluid-hero': ['clamp(2.4rem, 5.6vw, 4.4rem)', { lineHeight: '1.04', letterSpacing: '-0.03em' }],
        'fluid-h2': ['clamp(1.8rem, 3.4vw, 2.7rem)', { lineHeight: '1.12', letterSpacing: '-0.02em' }],
        'fluid-h3': ['clamp(1.15rem, 1.7vw, 1.4rem)', { lineHeight: '1.25', letterSpacing: '-0.01em' }],
        'fluid-lead': ['clamp(1.02rem, 1.4vw, 1.2rem)', { lineHeight: '1.65' }],
        'fluid-stat': ['clamp(2rem, 4vw, 3.1rem)', { lineHeight: '1', letterSpacing: '-0.03em' }],
      },
      maxWidth: {
        shell: '76rem',
      },
      keyframes: {
        'word-in': {
          '0%': { opacity: '0', filter: 'blur(10px)', transform: 'translateY(0.42em)' },
          '100%': { opacity: '1', filter: 'blur(0)', transform: 'translateY(0)' },
        },
        'gradient-pan': {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        'aurora-drift': {
          '0%, 100%': { transform: 'translate3d(0, 0, 0) scale(1.04)', opacity: '0.72' },
          '50%': { transform: 'translate3d(-2.5%, 1.5%, 0) scale(1.12)', opacity: '1' },
        },
        marquee: {
          '0%': { transform: 'translate3d(0, 0, 0)' },
          '100%': { transform: 'translate3d(-50%, 0, 0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-160% 0' },
          '100%': { backgroundPosition: '260% 0' },
        },
        'float-soft': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
        'pulse-ring': {
          '0%': { opacity: '0.55', transform: 'scale(0.96)' },
          '70%, 100%': { opacity: '0', transform: 'scale(1.5)' },
        },
      },
      animation: {
        'word-in': 'word-in 0.78s cubic-bezier(0.22, 1, 0.36, 1) both',
        'gradient-pan': 'gradient-pan 7s ease-in-out infinite',
        'aurora-drift': 'aurora-drift 22s ease-in-out infinite',
        marquee: 'marquee 26s linear infinite',
        shimmer: 'shimmer 2.6s ease-in-out infinite',
        'float-soft': 'float-soft 6s ease-in-out infinite',
        'pulse-ring': 'pulse-ring 2.4s ease-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;

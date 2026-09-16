/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        buddy: {
          bg: '#090d16',
          card: '#111827',
          cardHover: '#172033',
          border: '#1f293d',
          borderLight: '#334155',
          cyan: '#06b6d4',
          cyanLight: '#22d3ee',
          cyanGlow: '#06b6d440',
          purple: '#8b5cf6',
          purpleLight: '#a855f7',
          purpleGlow: '#8b5cf640',
          pink: '#ec4899',
          amber: '#f59e0b',
          emerald: '#10b981',
          text: '#f1f5f9',
          muted: '#94a3b8',
          darkMuted: '#64748b'
        }
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace']
      },
      animation: {
        'pulse-glow': 'pulseGlow 3s ease-in-out infinite',
        'float': 'float 4s ease-in-out infinite'
      },
      keyframes: {
        pulseGlow: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '0.8' }
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-6px)' }
        }
      }
    }
  },
  plugins: []
};

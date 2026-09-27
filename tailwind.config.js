/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{html,js}",
    "./redesign_preview.html"
  ],
  theme: {
    extend: {
      colors: {
        slate: {
          850: '#1b2230',
          900: '#141923',
          950: '#0b0f14'
        }
      }
    },
  },
  plugins: [],
}

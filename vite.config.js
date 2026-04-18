import { defineConfig } from 'vite'
import { readFileSync }  from 'fs'

const { version } = JSON.parse(readFileSync('./package.json', 'utf8'))

export default defineConfig({
  root: 'src',
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
})

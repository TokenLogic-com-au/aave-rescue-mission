import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['js-scripts/**/*.test.ts'],
  },
});

import { createApp } from './app.js';

const PORT = Number(process.env.PORT || 3001);
const app = createApp();

app.listen(PORT, () => {
  console.log(`Image Collector 2 running at http://localhost:${PORT}`);
});

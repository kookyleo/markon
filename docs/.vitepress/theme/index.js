import DefaultTheme from 'vitepress/theme';
import DownloadButton from './components/DownloadButton.vue';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('DownloadButton', DownloadButton);
  },
};

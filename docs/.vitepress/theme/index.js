import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import DownloadButton from './components/DownloadButton.vue';
import SelectionFeedback from './components/SelectionFeedback.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'layout-bottom': () => h(SelectionFeedback),
    });
  },
  enhanceApp({ app }) {
    app.component('DownloadButton', DownloadButton);
  },
};

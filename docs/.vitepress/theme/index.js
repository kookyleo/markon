import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import DownloadButton from './components/DownloadButton.vue';
import SelectionFeedback from './components/SelectionFeedback.vue';
import FeatureGallery from './components/FeatureGallery.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-before': () => h(DownloadButton, { mode: 'nav' }),
      'layout-bottom': () => h(SelectionFeedback),
    });
  },
  enhanceApp({ app }) {
    app.component('DownloadButton', DownloadButton);
    app.component('FeatureGallery', FeatureGallery);
  },
};

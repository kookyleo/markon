import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import DownloadButton from './components/DownloadButton.vue';
import DocSectionFocus from './components/DocSectionFocus.vue';
import SelectionFeedback from './components/SelectionFeedback.vue';
import FeatureGallery from './components/FeatureGallery.vue';
import HeroLogoSync from './components/HeroLogoSync.vue';
import HomeLocaleSync from './components/HomeLocaleSync.vue';
import HomeDownloadSection from './components/HomeDownloadSection.vue';
import HomeShortcuts from './components/HomeShortcuts.vue';
import LocalePreference from './components/LocalePreference.vue';
import SiteFooter from './components/SiteFooter.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-before': () => h(DownloadButton, { mode: 'nav' }),
      'nav-bar-content-after': () => h(LocalePreference),
      'nav-screen-content-after': () => h(LocalePreference, { mobile: true }),
      'layout-bottom': () => [
        h(SiteFooter),
        h(SelectionFeedback),
        h(HeroLogoSync),
        h(HomeLocaleSync),
        h(DocSectionFocus),
        h(HomeShortcuts),
      ],
    });
  },
  enhanceApp({ app }) {
    app.component('DownloadButton', DownloadButton);
    app.component('FeatureGallery', FeatureGallery);
    app.component('HomeDownloadSection', HomeDownloadSection);
  },
};

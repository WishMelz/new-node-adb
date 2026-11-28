import { createApp } from 'vue'
import Button from 'tdesign-vue-next/es/button'
import Dialog from 'tdesign-vue-next/es/dialog'
import Drawer from 'tdesign-vue-next/es/drawer'
import Input from 'tdesign-vue-next/es/input'
import Loading from 'tdesign-vue-next/es/loading'
import Select from 'tdesign-vue-next/es/select'
import Tooltip from 'tdesign-vue-next/es/tooltip'
import 'tdesign-vue-next/es/style/index.css'
import './style.css'
import App from './App.vue'

createApp(App)
  .use(Button)
  .use(Dialog)
  .use(Drawer)
  .use(Input)
  .use(Loading)
  .use(Select)
  .use(Tooltip)
  .mount('#app')

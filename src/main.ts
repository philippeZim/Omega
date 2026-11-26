import "./lib/windowBoot";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { installSmoothWheel } from "./lib/smoothWheel";

installSmoothWheel();

export default mount(App, { target: document.getElementById("app")! });

/*
 * FROZEN CONSUMER FIXTURE (RULES §9).
 * Changes require a matching contract manifest change and the CONTRACT.md
 * deprecation procedure.
 */
import { mount } from "svelte";
import App from "./App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("app mount target is missing");

mount(App, { target });

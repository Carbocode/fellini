import { For, Show, createEffect, onCleanup, type Component } from "solid-js";
import { IconMovie, IconX } from "@tabler/icons-solidjs";
import { aboutDialogOpen, setAboutDialogOpen } from "../store";
import {
  ABOUT_DETAILS,
  ABOUT_FOOTNOTE,
  ABOUT_HERO_BADGES,
  ABOUT_METRICS,
  ABOUT_SOFTWARE_SECTIONS,
} from "../lib/about";
import { Button, IconButton } from "./ui";

const AboutDialog: Component = () => {
  const close = () => setAboutDialogOpen(false);
  const totalSoftware = () =>
    ABOUT_SOFTWARE_SECTIONS.reduce((count, section) => count + section.entries.length, 0);

  createEffect(() => {
    if (!aboutDialogOpen()) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <Show when={aboutDialogOpen()}>
      <div
        class="dialog-overlay"
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div class="dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
          <div class="dialog-header">
            <h2 id="about-title">About Fellini</h2>
            <IconButton onClick={close} aria-label="Chiudi finestra About">
              <IconX size={16} />
            </IconButton>
          </div>
          <div class="dialog-body about-dialog-body">
            <div class="about-layout">
              <aside class="about-sidebar">
                <section class="about-hero-card">
                  <div class="about-hero">
                    <div class="about-logo" aria-hidden="true">
                      <IconMovie />
                    </div>
                    <div class="about-hero-copy">
                      <span class="about-eyebrow">Software inventory</span>
                      <h3>Fellini</h3>
                      <p>
                        About tecnico dell'applicazione, del runtime locale e dei componenti open
                        source dichiarati nel progetto.
                      </p>
                    </div>
                  </div>

                  <div class="about-badge-row">
                    <For each={ABOUT_HERO_BADGES}>
                      {(badge) => <span class="about-badge">{badge}</span>}
                    </For>
                  </div>

                  <div class="about-metric-grid">
                    <For each={ABOUT_METRICS}>
                      {(metric) => (
                        <div class="about-metric-card">
                          <span>{metric.label}</span>
                          <strong>{metric.value}</strong>
                        </div>
                      )}
                    </For>
                  </div>
                </section>

                <section class="about-panel">
                  <div class="about-panel-header">
                    <div>
                      <h3 class="about-section-title">Dettagli software</h3>
                      <p class="about-panel-copy">Metadati del prodotto e del runtime supportato.</p>
                    </div>
                    <span class="about-count">{ABOUT_DETAILS.length} voci</span>
                  </div>
                  <div class="about-detail-list">
                    <For each={ABOUT_DETAILS}>
                      {(detail) => (
                        <div class="about-detail-row">
                          <span>{detail.label}</span>
                          <strong>{detail.value}</strong>
                        </div>
                      )}
                    </For>
                  </div>
                </section>
              </aside>

              <main class="about-main">
                <section class="about-panel about-panel--inventory">
                  <div class="about-panel-header">
                    <div>
                      <h3 class="about-section-title">Software open source usato</h3>
                      <p class="about-panel-copy">{ABOUT_FOOTNOTE}</p>
                    </div>
                    <span class="about-total-pill">{totalSoftware()} componenti</span>
                  </div>

                  <div class="about-section-stack">
                    <For each={ABOUT_SOFTWARE_SECTIONS}>
                      {(section) => (
                        <div class={`about-subsection about-subsection--${section.tone}`}>
                          <div class="about-subsection-header">
                            <div class="about-subsection-copy">
                              <h4>{section.title}</h4>
                              <p>{section.summary}</p>
                            </div>
                            <span class="about-count">{section.entries.length} elementi</span>
                          </div>
                          <div class="about-software-list">
                            <For each={section.entries}>
                              {(entry) => (
                                <article class="about-software-item">
                                  <div class="about-software-head">
                                    <strong>{entry.name}</strong>
                                    <code>{entry.version}</code>
                                  </div>
                                  <p>{entry.role}</p>
                                  <Show when={entry.note}>
                                    <small>{entry.note}</small>
                                  </Show>
                                </article>
                              )}
                            </For>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </section>
              </main>
            </div>
          </div>
          <div class="dialog-footer">
            <span class="dialog-status">{ABOUT_FOOTNOTE}</span>
            <Button onClick={close}>
              Chiudi
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default AboutDialog;

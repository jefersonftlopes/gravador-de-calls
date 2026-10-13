# Chrome Web Store listing: English (en, default locale)

Ready-to-paste texts for the Chrome Web Store developer dashboard, English listing. English is the default locale (`default_locale: "en"`), so this listing is the fallback for every language without its own listing, and the privacy tab and the test instructions (single fields, read by the reviewers) use the texts below. The Portuguese listing is in [listagem-pt_BR.md](./listagem-pt_BR.md); screenshots and the promo tile are described in [capturas.md](./capturas.md).

Nothing here has been submitted to the store: the author submits it.

## Name

```
Gravador de Calls
```

Same name in both languages (it is the brand). No "Meet" or "Teams" in the name: the store's trademark policy rejects names that suggest a partnership. In the manifest it comes from `__MSG_...__` in `_locales/en/messages.json`.

## Summary (132 characters max)

```
Records, tab by tab, only the other participants' audio in Google Meet and Microsoft Teams calls, on your own computer.
```

119 characters (counted with `[...text].length` in Node). The dashboard does not have a field for it: the store shows the manifest `description`, which is the `extDescription` message in `public/_locales/en/messages.json`. To change the summary, change that message and upload a new package.

## Detailed description

Plain text (the store accepts no HTML or Markdown; line breaks and the "•" bullets show as they are).

```
Gravador de Calls automatically records, tab by tab, the audio of the other participants in your Google Meet and Microsoft Teams calls in Chrome. Each call becomes a separate recording, saved on your computer together with the call details.

HOW IT WORKS
• When the call actually starts (past the join screen and the waiting room), recording of that tab begins without a click. The icon shows REC on the tab.
• Several calls at the same time, in different tabs, become separate recordings: the audio of one never mixes with another.
• It records only the audio the call page receives from the other participants. Your microphone is never recorded.
• When the call ends (you leave, the call ends or the tab closes), the audio (audio.webm) and an info.json with the title, date, duration and the participants' display names are saved to Downloads/Call recordings (Downloads/Gravações de calls when Chrome is in Portuguese), one folder per call.
• If the tab or Chrome crashes mid-call, what was already recorded is not lost: the recording is saved as interrupted.

ALSO INCLUDED
• Tab mode: when a call does not pick up audio, the Alt+Shift+G shortcut (or the popup button) records what the tab plays, on other sites too.
• Volume for this tab: 0% to 200% on any tab, from the popup, without changing the level of the recordings.
• Leave when the call empties (optional, off by default): leaves the call and closes the tab when you are alone or almost everyone has left, always after the recording is saved.
• Automatic recording can be turned on or off per platform. Recordings shorter than 30 seconds (adjustable) are discarded.
• Advanced: saving to a folder of your choice and transcribing each call on your own computer require the local helper, which is not yet distributed through the store. Without it, everything above works normally.

PRIVACY
• No server, no account and no analytics. The extension sends nothing off your computer.
• The audio of a call in progress is kept in the extension's local storage only until it is saved.
• Privacy policy: https://gravador-de-calls.vercel.app/en/privacy

BEFORE YOU RECORD
Recording a conversation may require the consent of every participant, depending on the country and state (all-party consent laws; in Brazil, the LGPD). Tell the people on the call: the decision to record, and that responsibility, are yours.

LIMITATIONS
• Works in desktop Chrome (version 120 or newer), on Google Meet and Microsoft Teams on the web, not in the installed apps. Tested on Chrome for macOS.
• In large calls, Meet only delivers the loudest voices of each moment to the browser; what does not reach the browser cannot be recorded.
• Sounds from the call interface itself (join chime, notifications) may appear in the recording.

Google Meet and Microsoft Teams are trademarks of their respective owners. Gravador de Calls is an independent tool, not affiliated with, sponsored or endorsed by Google or Microsoft.
```

## Category

**Recommended: Productivity > Communication** (in the store's current taxonomy, "Communication" sits under "Productivity", so both options from the brief are the same choice). That is where extensions working on top of Meet and Teams live, and it matches what the product does: keep what was said in a call. "Productivity > Tools" is the second, more generic option.

## Language

English. It is the default listing.

## URLs

| Field | Value |
|---|---|
| Homepage URL | `https://gravador-de-calls.vercel.app/en` |
| Privacy policy URL | `https://gravador-de-calls.vercel.app/en/privacy` |
| Support URL (optional) | `https://gravador-de-calls.vercel.app/en` (contact in the footer) |
| Official URL (optional) | leave empty: it requires verifying the domain in Google Search Console, and `vercel.app` is not an owned domain |

The Portuguese pages are `https://gravador-de-calls.vercel.app/` and `https://gravador-de-calls.vercel.app/privacidade`; each page links to the other language at the top.

## Single purpose

```
Record, on the user's computer, the audio of the Google Meet and Microsoft Teams calls open in Chrome, one recording per tab, with only the other participants' audio and the call details. The secondary features serve that purpose: tab mode is the other way to capture the tab's audio when automatic recording picks up no sound, the per-tab volume uses the same tab capture so the user can hear the call at the volume they need, and the auto-leave ends the call and the recording when the meeting empties.
```

Known risk: the per-tab volume works on any site, and a reviewer may read it as a second purpose. If the store rejects the item for "single purpose", the fix is to limit the volume to call tabs or drop it from the store build.

## Permission justifications

Checked against the final manifest of version 0.3.0 (the store build kept all nine permissions, see docs/LOJA.md section 2). `tests/unit/pacote-loja.test.ts` fails if a manifest permission is missing here, in the Portuguese listing or in section 13 of either privacy policy (`site/privacidade.html` and `site/en/privacy.html`).

| Permission | Justification (paste into the dashboard) |
|---|---|
| `storage` | Stores the user's settings (automatic recording per platform, minimum duration, profile name, auto-leave) and the state of recordings in progress, so they survive a service worker restart. Everything stays local. |
| `unlimitedStorage` | The audio of a call in progress is kept in chunks in the extension's IndexedDB until it is saved, so it is not lost if the tab or Chrome crashes. A call lasting several hours must not hit the quota and lose its end. The chunks are deleted as soon as the recording is saved. |
| `offscreen` | The offscreen document builds the audio file for the download (the service worker cannot create Blob URLs) and, in tab mode and with the per-tab volume, plays the captured tab sound so the user keeps hearing the call. |
| `nativeMessaging` | Talks to the optional local helper (a separately installed program, not yet distributed through the store) that saves to a folder chosen by the user and transcribes calls on the computer itself. Without the helper, the connection simply fails and the extension saves to Downloads. |
| `downloads` | Saves each recording (audio.webm and info.json) to Downloads/Call recordings (Downloads/Gravações de calls in Portuguese), one folder per call. It is the default destination of the store version. |
| `notifications` | Tells the user when a recording has had no audio for 60 seconds (suggesting tab mode), when a call tab opened before installation needs a reload, and when a recording could not be saved. |
| `tabCapture` | Tab mode and per-tab volume: captures the current tab's sound, only after a user gesture (Alt+Shift+G shortcut, toolbar icon or popup button), to record what the tab plays or change its volume. |
| `activeTab` | In the same gesture as tab mode, provides the current tab's title and URL when it is not a Meet or Teams page, to name the recording folder. It grants no access to any tab outside that gesture. |
| `alarms` | Retries, every minute, saving a recording that could not be saved at the end (for example, with a full disk) and recovers recordings left open after a Chrome crash. |
| Host permissions `https://meet.google.com/*`, `https://meet.google.com.mcas.ms/*`, `https://meet.google.com.mcas-gov.us/*`, `https://meet.google.com.mcas-gov.ms/*`, `https://teams.microsoft.com/*`, `https://teams.cloud.microsoft/*`, `https://teams.live.com/*`, `https://teams.microsoft.com.mcas.ms/*`, `https://teams.microsoft.com.mcas-gov.us/*`, `https://teams.microsoft.com.mcas-gov.ms/*`, `https://teams.cloud.microsoft.mcas.ms/*`, `https://teams.cloud.microsoft.mcas-gov.us/*`, `https://teams.cloud.microsoft.mcas-gov.ms/*`, `https://teams.live.com.mcas.ms/*`, `https://teams.live.com.mcas-gov.us/*`, `https://teams.live.com.mcas-gov.ms/*` | The content scripts run only on the call pages: they detect when the call starts and ends, record the audio the page receives from the other participants, and read the call title and the participants' display names. The MAIN world script, at `document_start` and in all frames, wraps `RTCPeerConnection` and the page's audio output points only to observe the remote audio: it does not change what those APIs return and never touches the microphone. It must load before the page's scripts because Meet and Teams create the audio connection early, sometimes inside an iframe. The hosts ending in `.mcas.ms`, `.mcas-gov.us` and `.mcas-gov.ms` are the same Meet and Teams pages when a company opens them through the Microsoft Defender for Cloud Apps session proxy (Conditional Access App Control), which appends that suffix to the host: the extension does exactly the same there, and nothing else on those domains. |
| Optional access to `https://api.openai.com/*` | API transcription (0.5.0): with the feature turned on by the user, the extension sends the call audio file to the provider's transcription API, with the user's own key, and gets the text back. It is an **optional permission**: it is not part of the install warning, Chrome asks for it at the moment the user turns the feature on in the settings, and without it nothing is sent. The key stays on the machine only, in its own slot of the extension storage, and is used only in the authorization header. No participant name and no other file of the recording leaves the computer. Off by default, and the choice is per Chrome profile. |

## Data usage (dashboard "Privacy" tab)

**Remote code:** "No, I am not using remote code." All JavaScript ships in the package (Vite and crxjs), with no `eval`, no `new Function` and no externally loaded script.

**User data: which boxes to tick.** The extension sends nothing off the computer, but it handles these data locally and writes files containing them. Ticking what it handles is the transparent reading and matches the privacy policy.

| Data type | Tick? | Why |
|---|---|---|
| Personally identifiable information | **Yes** | `info.json` keeps the participants' display names and the user's own name, read from the call page. |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | No | No password, token or credential. |
| Personal communications | **Yes** | The call audio is the content of a communication. With API transcription turned on by the user (0.5.0), that audio is **sent** to the API of the provider they chose, with their own key. |
| Location | No | The time zone in `info.json` is not location (no IP or GPS). |
| Web history | No | The extension does not log visited pages: it only keeps the URL and title of the call page that was recorded, as data of that recording. If the store questions it, ticking it changes nothing in the product. |
| User activity | No | No clicks, keystrokes, scrolling or network monitoring. |
| Website content | **Yes** | The call title, the tab's title and URL and the names read from the page. |

**The three certifications** (tick all three):

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** `https://gravador-de-calls.vercel.app/en/privacy`

## Test instructions for the reviewer

Paste into the dashboard "Test instructions" field:

```
No account, login or local helper is needed. The local helper is optional and not required for the review: without it, the extension saves recordings to Downloads/Call recordings (Downloads/Gravações de calls if Chrome is in Portuguese), and the settings show the custom folder and transcription under "Advanced: local helper" as optional features that require the helper.

0. First run: right after installation a welcome page opens with a notice about what is recorded and about consent. Click "I understand" at the end of the page. Until then automatic recording stays off and the icon shows "!" (tab mode still works, because it always starts from your own click).

1. Tab mode, no meeting needed (the quickest way to see a recording):
   a. Open any page that plays audio (for example, a video).
   b. Press Alt+Shift+G (Option+Shift+G on macOS), or open the popup and click "Record this tab (tab mode)". The icon shows REC.
   c. Let it play for at least 40 seconds (recordings shorter than 30 seconds are discarded on purpose) and press Alt+Shift+G again.
   d. Open Downloads/Call recordings/<YYYY-MM>/<date and time> - <tab title> (Other site)/: it contains audio-aba.webm and info.json. The popup also lists it under "Recent recordings".

2. Volume for this tab: on the same page, open the popup and move the "This tab's volume" control (0% to 200%). The sound changes right away; "100%" returns the tab to normal.

3. Automatic recording in Google Meet (needs a second participant, which can be you on another device):
   a. At meet.google.com, start an instant meeting and join it.
   b. Join the same meeting from a second device (a phone with the Meet app, or another browser with another account or as a guest) and speak for more than 30 seconds.
   c. On the computer, recording starts on its own once the call actually starts; the popup shows the recording with its timer and whether audio is arriving.
   d. Leave the call. The call folder appears in Downloads/Call recordings with audio.webm (only the second device's voice, without the computer's microphone) and info.json (title, date, duration, participants).

4. Microsoft Teams on the web (teams.live.com, with a free personal account) works the same way.

Recording a conversation may require the consent of every participant; the extension is meant for users to record their own calls after informing the participants.
```

The steps above use the final English texts of version 0.3.0 (welcome page, popup labels and the localized folder and suffix names).

## Distribution (suggestion)

- Pricing: free.
- Regions: all.
- Visibility: start as **Unlisted** (only people with the link can install) for the first week of use, then switch to Public. The author's decision.

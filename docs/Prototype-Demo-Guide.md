# Oscenia ERP — Prototype Demo Guide

**Project Management + Team Chat · Event Invitations, RSVP & Check-in · CRM**

This guide walks through every feature in the clickable prototype, step by step. It follows the client decisions in the BRD (v0.2, `docs/BRD-PM-Events-CRM-v0.2.pdf`).

> **This is a front-end prototype.** Everything works on screen, but there is no server behind these features yet. Messages are not really sent, the QR camera is simulated, and data is kept in your own browser. See [Good to know](#8-good-to-know) at the end.

**Updated 5 Oct 2026** with your fourth round of feedback: guest tables you can type freely, a less cluttered journal, a pop-up that shows (and lets you edit) the journal entry before money is posted, and two dates on every receipt and payment. Start with [section 0000](#0000-whats-new-round-4). [Section 000](#000-whats-new-round-3), [section 00](#00-whats-new-round-2) and [section 0](#0-whats-new-since-your-feedback-round-1) still list rounds 3, 2 and 1.

---

## 0000. What's new (round 4)

Each row is one point from your fourth round of feedback (5 Oct). Your saved demo data is kept; nothing resets.

| # | You asked | What changed | How to check |
|---|---|---|---|
| 1 | Write the guest's table number freely | The **Table** field is now free text: *T1*, *VIP-1*, *Garden 3*… up to 30 characters. While you type it suggests the event's tables and every table already used for that event. It saves when you press Enter or click away; Esc puts the old value back. The check-in desk shows (and can change) the same table. | Events → **Wibowo–Sari Wedding** → **Guests & RSVP** → click a guest's *Table* → type `VIP-1` → Enter. Then **Check-in** → search that guest: the card shows *VIP-1*. (§5.4, §5.6) |
| 2a | The journal is too cluttered | Finance → **Accounting** → *Journal* has **type chips** (*All · Client invoices · Client payments · Vendor bills · Vendor payments · Manual · Assets & stock · Corrections*), a **Search voucher, memo or project** box, and **Hide reversed pairs**, which is **on by default**. It hides an entry that was reversed together with its reversal (they cancel out) and says how many are hidden, with **Show them** to bring them back. If a reversal is itself reversed, the whole chain stays visible. Only the list changes: every report still counts every entry. Your filter choices are remembered in this browser. | Finance → **Accounting** → *Journal*: the line under the filters says *"N hidden — reversed entries and their reversals net to zero"*. Click **Client payments**, then type `DP received` in the search. |
| 2b | A pop-up showing the journal entry before posting, to edit the details or the tax | A pop-up opens **before** the money is posted for: **client down payment** (Finance → *Confirm Down Payment*), **receive payment** (Receivables), **pay a vendor bill** (Payables), **pay a vendor down payment** (Purchase Orders, new: it used to post straight away) and **settle a purchase order**. You can change both dates, the memo, the cash/bank account, the PPh 23 withholding (on/off and the amount) and the lines themselves: add a bank-charge line, split the cash, change notes. The confirm button (e.g. **Confirm down payment**, **Pay down payment**) works only when debits equal credits. The receivable (1201) or payable (2102) line is **locked**: it clears the invoice or bill at its full amount, so the open items and the PO stay correct. No other line may use 1201 or 2102. Entries that come with the payment (the DP invoice, the vendor bill, a PO variance) are shown above it, read-only. **Reset to calculated** undoes hand edits. It all works in this demo, without a server. | Finance → a deal → **Confirm Down Payment**: the pop-up shows *DP invoiced* (read-only) and *DP received* (editable). Change the tax amount: the lines follow. Add a line (say *6101 Office Overhead*, debit 10,000, note *bank charge*) and lower the cash line by 10,000 → confirm. Then **Purchase Orders** → an approved order → **Pay DP**: the same pop-up. |
| 2c | Two dates: the date on the receipt and the date it was received; reports use the received date | Every pop-up above, and the manual journal entry, has **Date on receipt** (for vendors: *Date on vendor receipt/invoice*) and **Date received (used in reports)**. The received date is the posting date: every report, period filter and balance uses it. The receipt date changes no figure; it is kept on the entry for checking against the paper. The journal list shows the received date with the receipt date under it when they differ, and the entry drawer shows both. | Confirm a DP or record a payment with *Date on receipt* 3 days before *Date received* → confirm → Finance → **Accounting** → *Journal*: the entry is listed on the received date with the receipt date below it. Open it: the drawer shows both. |

---

## 000. What's new (round 3)

Each row is one point from your third round of feedback (4 Oct). Your saved demo data is kept this time; nothing resets.

| # | You asked | What changed | How to check |
|---|---|---|---|
| 1 | A Google Calendar section under CRM & Clients | **Google Calendar** now has its own page, under **CRM & Clients** in the sidebar. It shows the month calendar, with the team's Google events in blue beside the CRM dates, and the connect card. The sync is still simulated. | Sidebar → **CRM & Clients** → **Google Calendar** (or the **Google Calendar** button at the top of CRM) → **Connect Google Calendar**. (§6.3) |
| 2 | A reply appears at the bottom of the main chat, with a quote of the original above it | One **Reply** button (the reply arrow) on every message. The reply is posted at the bottom of the chat, with a quote of the original right above the text. **Threads are removed**: no more side panel, and older thread replies now show as quoted replies. | Team Chat → any channel → hover a message → **Reply** → type → Enter. (§4.4) |
| 3 | A PO pipeline inside Vendor Management | Vendors has three views: **Vendors** (the table), **Vendor lifecycle** (the vendor board, renamed from *Pipeline*) and **PO pipeline**, with five stages: **PO Issued → DP Paid → In Progress → Delivered / Completed → Fully Paid**. Each order card has a five-step progress strip. | Vendors → **PO pipeline**: PO-3003 (SoundForge) is in *In Progress*. (§6b, §6c) |
| 4 | Our own designs in the invitation templates, added by our design team | A **Template Studio** for the CEO and PMs. **Duplicate** a built-in or start a new design, then set colours, fonts, cover layout, ornament, artwork (cover, frame, ornament, page texture) and section order, with a live preview. **Add to gallery** puts it in every event's **Change template** gallery, with a **Design team** badge. Limits: templates are saved **in this browser only**; a studio template opened in another browser draws as **Gala**; a new layout or a new kind of section still needs a developer. | Sidebar → **Events & Invitations** → **Invitation templates** (or **Templates** on the Events page) → **Duplicate** Royal → change the accent → **Save** → **Add to gallery**. Then **Wibowo–Sari Wedding** → *Invitation*: it is in the gallery. (§5.1) |

---

## 00. What's new (round 2)

Each row is one point from your second round of feedback (2 Oct). If you saw the earlier preview, the demo data resets to the new version automatically.

| # | You asked | What changed | How to check |
|---|---|---|---|
| CH3 | Chat UI/UX like Discord | Discord's layout and behaviour in Oscenia's navy and gold. Server rail with a white pill (tall = open, short = unread) and a red badge for mentions and DMs. Server-name **▾ menu**. Foldable **Text / Voice channels** and **Direct messages**. Messages from one person within a few minutes are grouped. **Voice channels**: a *Meeting room* per project and a *Lounge* for the company. A **user panel** bottom-left with status, mic and headphones. The member list shows **Online / Offline**. | Team Chat → **Aurora Bank Annual Gala** → under *Voice channels* click **Meeting room**. Teammates join and are listed under it. Press **Back to chat**: the panel bottom-left says *Voice connected*. (§4.1, §4.5) |
| CH5 | Restrict who may or may not join a chat | Every channel has **Who can join**: everyone on the project, selected divisions, or invite only. It also has a **block list**. Others see the channel greyed with a 🔒 and can **Request to join** with a note. The PM, or a leader whose division works on the project, approves or declines. | **Viewing as Rina M.** → Aurora Gala → **#production** is locked, and her request is waiting. **Viewing as Hendra T.** → 🔔 *"Rina M. wants to join #production"* → **Approve**. (§4.6) |
| CH4 | AI summary and minutes (MOM) of calls; restrict who sees the minutes and files | Every call leaves a **meeting record**: transcript, notes and files from the call, and **Summary & MOM**. **Generate AI summary & MOM** writes the minutes. In this demo it is a simulated AI summary, clearly labelled; real AI (DeepSeek) is ready to switch on. **The host decides** who reads them: the people on the call (default), the whole channel, or named people. Files can be **view-only**. The PM reads minutes of channel calls, never of direct-message calls. | **Viewing as Yoga K.** → Aurora Gala → #general → the 24 Jul call says *"Minutes restricted"*. **Viewing as Dinda A.** → **Minutes**. (§4.7) |
| V2 | A pipeline for vendors, to see their stages | Vendors → **Vendor lifecycle** (called *Pipeline* until round 3): **Prospect → Onboarding → Approved → Active**, with *On hold* and *Blacklisted* below. An onboarding checklist (NPWP, bank account, PIC, signed MoU, reference check). Only finance or the CEO approves. Only Approved or Active vendors can get a new PO. | Vendors → **Vendor lifecycle**: *BrightRig* is in Onboarding at 3/5. (§6c) |
| INV | Invitations like Invitato: designed templates, our own photos, video and music, personal links | A **gallery of 6 templates** (Corporate: Gala, Launch, Summit; Wedding & private: Royal, Minimal, Garden). Sections switch on and off and are filled in, with photo, video and music uploads. **The client designs from a private link** and submits it; Oscenia **reviews and publishes**, and guests keep the last approved version. Guests get a **cover with their name**, music, a countdown with **Add to calendar**, a full-screen gallery, RSVP and QR, **wishes** (can be held for approval) and gift details with copy buttons. **Send invitations** by WhatsApp and email from the platform, or the client sends each guest's link from their own WhatsApp. | Events → **Wibowo–Sari Wedding** → *Invitation* opens the gallery. The client link is `/invite/EV-03/edit?key=wibowo-5h2m`. Open a guest's personal link from *Guests & RSVP*. (§5) |

### Questions for you (round 2)

1. **CH4:** are the **minutes** laid out the way you want (overview, agenda, discussion, decisions, action items with owner and due date)?
2. **CH4:** by default only the **people on the call** can read the minutes. Is that the right default?
3. **CH5:** channel settings and join requests are decided by the **PM or the project's division leaders**. Should anyone else decide?
4. **INV:** only the **CEO and PMs can publish** an invitation, but anyone who can open an event can **send** it. Should sending also be limited?

---

## 0. What's new since your feedback (round 1)

Each row is one point from your feedback. "How to check" gives the quickest way to see it; the section in brackets has the full steps. If you saw the earlier preview, the demo data has been reset to the new version automatically.

### Workspace & general

| # | You asked | What changed | How to check |
|---|---|---|---|
| W3 | The PM could not approve a task | Only the person a task is assigned to can press **Submit for approval**. The PM and leaders see a note instead, so the PM's final approval always works. | Viewing as **Agus P.**, open **T-101** (Aurora Gala): the drawer says *"Only the assignee can submit this task for approval."* Switch to **Rina M.**: she has **Submit for approval**. (§3.4) |
| W1 | A Division Leader could only assign themselves | A leader can assign **anyone in their division**. People not yet on the project are marked *"will be added to the project"*, and assigning adds them. | Viewing as **Dinda A.**, open **Wibowo–Sari Wedding** → **New task** → *Assign to*: Rina M. and Nadia R. appear with *"· will be added to the project"*. (§3.5) |
| W2 | Attach files to tasks | Task drawer → **Attachments**: PDF, JPG, PNG or Word (.docx), **up to 10 MB each**, up to 10 per task. | Open **T-101**: it already has *run-of-show-v3-draft.docx*. Drop a PDF or photo on it. (§3.8) |
| — | The "Demo mode" tag covered content | The floating tag is gone. The top bar shows a **DEMO MODE** chip instead (on a computer). | Look at the top bar after signing in. (§1) |

### Events, RSVP & check-in

| # | You asked | What changed | How to check |
|---|---|---|---|
| E1 | "New event" could not add a new client | The *Client* list ends with **+ New client**, which opens a small form and selects the new client. | Events & Invitations → **New event** → *Client* → **+ New client**. (§5) |
| R1 | Several checkpoints (Main Entrance, VIP, Goodie Bag), logging place and time | Each device picks where it is **Scanning at**. Every scan is logged with checkpoint and time. Staff are warned about a repeat scan, or a guest outside a checkpoint's categories, and can still let them in. | Aurora Gala → **Check-in** → *Scanning at* **VIP Lounge** → search **Fitri** → a warning says the lounge is for VIP guests. Meridian's **Scan log** shows 37 seeded scans. (§5.6) |
| R2 | Guest categories (VIP / Media / Regular / Vendor) | A **Category** column, filter pills with counts, search, and a `category` column in CSV import and export. | Aurora Gala → **Guests & RSVP**: pills *VIP · 6, Media · 3, Regular · 21, Vendor · 1*. (§5.4) |
| R3 | Reopening the RSVP link should show the QR again | The phone remembers who replied, and every guest also has a **personal link** that shows their reply and QR on any device. | Guests & RSVP → link icon at the end of a row (**Copy personal link**) → open it in a new tab. (§5.3) |
| R4 | Thank-you / feedback message after the event (D+1) | Reminders can run **after the event** (D+n) to *Guests who came* or *RSVP'd but did not come*. `{feedback}` inserts your feedback-form link. | Aurora Gala → **Reminders**: the D+1 thank-you rule. (§5.5) |
| R5 | Internal notes on guests who RSVP'd but did not come | An **Internal note** column in the attendance report, saved with who and when. Guests never see it. | Meridian → **Attendance report** → *RSVP'd, did not come*: Elsa Nugroho and Fajar Setiawan already have notes. (§5.7) |
| R6 | More than 10 people per invitation | Up to **50** per invitation. Above 10 the guest gets a − / + counter instead of a list. | Aurora Gala → Invitation → **RSVP settings** → *Up to __ people per invitation* = 20, then open as guest. (§5.1) |
| R7 | Your own RSVP questions (text, multiple choice, dropdown) | Invitation → **RSVP settings** → **Your questions**: up to 10 per event, required or optional, for everyone or only guests who accept. Answers appear in the guest list, at check-in and in the export. | Aurora Gala has three: *Meal preference*, *shuttle*, *song request*. Guests & RSVP → **Answers from guests attending** shows the tallies. (§5.1, §5.4) |

### CRM, chat & vendors

| # | You asked | What changed | How to check |
|---|---|---|---|
| C1 | Tick boxes and Select all; send a campaign only to ticked contacts | A tick box on every contact, and one in the header for everything shown. A campaign goes to the ticked contacts **who gave marketing consent**; the others are skipped and named in a warning. | CRM → **Guest contacts** → tick a few → **Compose campaign**. (§6.2) |
| C2 | A Google Calendar section | Relationship calendar → **Month**: a month grid of nudges, birthdays, anniversaries and events. **Connect Google Calendar** (simulated) adds the team's Google events in blue. | CRM → Relationship calendar → **Month** → **Connect Google Calendar**. (§6.3) |
| CH1 | Replies in the main chat, quoting the original | **Reply** posts in the main chat with a quote (click it to jump to the original). Threads were removed in round 3 (§000). | Aurora Gala → **#field**: Rina's reply quoting Dinda. (§4.4) |
| CH2 | Group and one-to-one calls, screen sharing | **Voice and video calls** from any channel or direct message, with mute, camera and **screen share** (simulated). **Direct messages** added: only the two people can read them. | Aurora Gala → #general → video icon. (§4.5) |
| V1 | PO pipeline: PO Issued → DP Paid → In Progress → Delivered → Fully Paid | Purchase Orders → **Pipeline**: five columns with counts and totals, and a **delivery status** on each order. Payment statuses are unchanged. | Purchase Orders → **Pipeline**. (§6b) |

### Coming next

| # | You asked | Status |
|---|---|---|
| J1 | Review and edit the journal (and tax) before posting a down payment or vendor payment | **Done in round 4.** The pop-up shows the real lines in the demo and lets you edit dates, memo, account, tax and lines before posting. See [section 0000](#0000-whats-new-round-4), row 2b. |
| J2 | Two dates: receipt date and date received; reports use the date received | **Done in round 4.** *Date on receipt* and *Date received (used in reports)* on every money pop-up and the manual entry; reports use the received date. See [section 0000](#0000-whats-new-round-4), row 2c. |
| CH4 | Real AI for meeting minutes | **Ready, switched off in the demo.** The minutes come from DeepSeek once its key is set in Oscenia's Vercel account (OpenAI can be used instead). Until then the demo shows a simulated summary, labelled as such. |

### Questions for you

We built a sensible default for each of these. Please confirm or tell us what you'd prefer:

1. **C1:** a ticked contact who did **not** give marketing consent is skipped, with a warning. Should staff be able to send to them anyway? (We recommend not.)
2. **C2:** what should the Google Calendar section do for you: show the team's Google events beside CRM dates, add CRM dates to Google, or something else?
3. **CH2:** we added one-to-one **direct messages** with the calls. Do you want them? (Not even the PM can read a DM.)
4. **R6:** is **50 people** per invitation enough?
5. **W2:** is **10 MB per file** the right limit?

---

## 1. Getting in

1. **Open the link** Oscenia shared with you (a Vercel "Share" link). Always open that link first. It unlocks the preview for your browser.
2. Go to the **`/erp/`** page of that site, if it didn't open there directly.
3. On the sign-in screen, click **CEO** in the **Demo accounts** list. This fills in the email and password for you. Then press **Sign in**.
   - Demo password for every account: `oscenia-demo-2026`.
   - Use the CEO account for this guide, because it sees every module.
4. On a computer, a **DEMO MODE** chip in the top bar confirms you are in the prototype (no server connected; changes stay in this browser).

**The four new modules** are in the left sidebar:

| Sidebar item | What it is |
|---|---|
| **Workspace & Tasks** | Projects, tasks, approvals, who is blocked and why |
| **Team Chat** | Discord-style chat per project |
| **Events & Invitations** | Invitation websites, RSVP, reminders, QR check-in, attendance report |
| **CRM & Clients** | Existing client list, plus guest contacts, the relationship calendar and a Google Calendar page |

> **The demo has a fixed "today": 26 July 2026.** All deadlines, "overdue" labels and "in 3 days" counts are measured from that date.

---

## 2. "Viewing as" — seeing each role's access

The Workspace and Chat screens have a gold **Viewing as** box at the top. It lets you see exactly what each person on the team would see, without signing in as them.

| Person | Role | What they can do |
|---|---|---|
| **Agus P.** | Project Manager | Sees everything; assigns anyone; gives the **final** approval |
| **Dinda A.** | Field Division Leader | Sees projects the Field division is on; assigns within Field; gives the **first** approval |
| **Maya S.** | Design Division Leader | Same, for the Design division |
| **Hendra T.** | Production Division Leader | Same, for the Production division |
| **Rina M., Putri L., Yoga K., Sela D.** | Staff | See their projects and all tasks there; can assign to peers and interns on their projects |
| **Kevin W., Nadia R.** | Intern | See **only their own tasks**, on their projects (Kevin is on two); cannot assign or approve |

The persona is **per browser tab**. You can open two tabs side by side, each viewing as a different person.

---

## 3. Workspace & Tasks

Open **Workspace & Tasks** in the sidebar.

### 3.1 All projects at a glance
1. The **Projects** tab shows one card per project, with:
   - the **PIC**, the divisions on the project and the event date;
   - counts for **Open**, **Approval** (waiting for sign-off), **Blocked** and **Overdue**;
   - a progress bar and the next deadline.
2. Click a card to open that project's task board.

### 3.2 Where work is blocked, and why
1. Open the **Blocked & overdue** tab.
2. Each blocked task shows its recorded **reason** and who holds it. For example:
   - **T-102**: waiting on the client's logo files.
   - **T-203**: permit waiting on a family consent letter.
   - **T-309**: venue hasn't sent the ceiling drawings.
3. Overdue tasks are marked **Overdue**, with how many days late.

### 3.3 Switch roles and watch access change
1. In **Viewing as**, pick **Dinda A. — Field Division Leader**. Only the projects Field works on remain, and the counts change.
2. Pick **Kevin W. — Design Intern**. The note at the top explains what an intern sees. Open a project: only Kevin's own tasks appear, and there is **no "New task" button**.
3. Pick **Agus P. — Project Manager** again. A fourth tab, **Team & access**, appears (PM only).

### 3.4 One task from assigned to approved (the two-stage approval)
1. **Viewing as: Kevin W. (Intern).** Go to **My tasks** and open **T-205 · Table-setting mockups**. The task drawer slides in.
2. Click **Start**, then **Submit for approval**.
3. **Viewing as: Maya S. (Design Leader).** In **My tasks → Waiting for my approval**, open T-205 and click **Approve (stage 1)**.
4. **Viewing as: Agus P. (PM).** Open T-205 again and click **Final approve (stage 2)**. The task is now **PM approved**.
5. Scroll down the drawer to the **Activity** trail. It shows who assigned the task, who started and submitted it, and who approved it at each stage, with times.

**Also try:**
- **Only the assignee submits.** Viewing as **Agus P.** or **Dinda A.**, open **T-101** (assigned to Rina): instead of *Submit for approval* the drawer says *"Only the assignee can submit this task for approval."* They can still mark it blocked or copy its link.
- **Mark blocked** asks for a reason. The reason then appears on the Blocked board.
- **Reject** asks for a comment and sends the task back to *In progress*.
- **Nobody approves their own work.** T-203 belongs to Dinda, who leads its division, so it goes straight to the PM.
- **Copy task link** copies a link that opens this exact task. The Team Chat section uses it.

### 3.5 Who may assign what
1. **Viewing as: Putri L. (Design Staff).** Open **Wibowo–Sari Wedding**, click **New task**. The *Assign to* list shows only staff and interns on that project.
2. **Viewing as: Dinda A. (Field Leader).** On the same project, the list shows **everyone in the Field division**: Dinda herself, plus *Rina M. — Field Staff · will be added to the project* and *Nadia R. — Field Intern · will be added to the project*. Assign a task to Rina (**Assign task**): she is added to the project and can now see it.
3. **Viewing as: an intern.** There is no New task button.

### 3.6 Access is enforced, not just hidden
1. **Viewing as: Nadia R. (Field Intern).**
2. Open this address in the same tab: `/erp/workspace/EVT-2026-CONF-03?task=T-301`
3. You get **"No access to this task"**. Nadia is not on that project, and the task isn't hers.

### 3.7 Team & access (PM only)
1. **Viewing as: Agus P.** → **Team & access** tab.
2. Tick which **divisions** work on each project, and which **staff and interns** are on each project.
3. Tick an intern onto a new project, switch to that intern, and the project appears for them.

### 3.8 Attach files to a task
1. Open **T-101 · Finalise run-of-show v3** (Aurora Gala). The drawer has an **Attachments** section, already holding *run-of-show-v3-draft.docx* from Rina.
2. Drop a file on **Drop files here or click to attach**, or click it to pick one. Allowed: **PDF, JPG, PNG or Word (.docx), up to 10 MB each**, up to 10 files per task.
3. Try a file of another type, or one over 10 MB: it is refused with the reason. A program renamed to `.pdf` is refused too.
4. The upload is logged in the task's **Activity**, and the task row shows a paperclip icon with the count.
5. Anyone who can see the task can attach until it is done. The uploader or the PM can remove a file.

In the prototype, photos keep a small preview, and PDF/Word files under 250 KB can be opened. Larger files keep only their name and size. With the backend every file is stored in full.

---

## 4. Team Chat

Open **Team Chat** in the sidebar.

### 4.1 Layout (like Discord)
- **Far left: the servers.** **Oscenia** holds company-wide channels and your direct messages. After a divider, there is one server per project; hover an icon to see its name, e.g. *Aurora Bank Annual Gala*.
  - The server you are in has a tall white **pill** and is gold.
  - A short pill means unread messages.
  - A red number counts @mentions and unread direct messages.
- **Next column: the server's channels.**
  - Click the **server name ▾** for *Task board*, *Invite people* (copies the link) and *Mark as read*. Managers also get *Create channel* and *Channel settings* (§4.6).
  - Channels sit in foldable categories: **Text channels** (`#general` plus one per division), **Voice channels** (*Meeting room*; *Lounge* in Oscenia) and, in Oscenia, **Direct messages**. Click a category name to fold it. Your browser remembers which ones are folded.
- **Bottom left: you.**
  - Click your name to set your **status**: Online, Idle, Do not disturb or Invisible.
  - The 🎙 and 🎧 buttons mute and deafen you in a call.
- **Middle: the messages.** Messages from the same person within a few minutes are grouped under one name. Hover a grouped line to see its time.
- **Right: who is in the channel**, split into **Online** and **Offline**. Other people's status is simulated in the demo.
- **On a phone**, ☰ in the header opens the servers and channels as a slide-in drawer.

### 4.2 Who sees which channels
1. **Viewing as: Agus P. (PM).** You see every server, including the private 🔒 **#leaders** channel.
2. **Viewing as: Nadia R. (Field Intern).** Only **Oscenia** and **Aurora Bank Annual Gala** remain, and #leaders is gone. Aurora's **#production** shows greyed with a 🔒: it is for the Production division, and Nadia can ask to join (§4.6).

### 4.3 Mentions and task links
1. Stay as **Nadia R.** and open **Aurora Bank Annual Gala → #general**.
2. In the message box, type `@Ri` and pick **Rina M.** from the list. Then type `#T-10` and pick **T-106** from the task list.
3. Press **Enter**. The message shows **@Rina M.** as a highlighted chip, with a **task card** below it (title, status, PIC, deadline).
4. Click the task card. The same task drawer as in the Workspace opens.
5. **Viewing as: Rina M.** The channel now shows a red **@1** mention badge, and the message is highlighted for her.

Pasting a copied task link into the box also turns it into a task card.

### 4.4 Replies, reactions, edits
1. **Reply with a quote.** **Viewing as: Rina M.**, open **Aurora Bank Annual Gala → #field**. Rina's message of 24 Jul shows a quote of Dinda's catering note. Click the quote to jump to the original.
   - To make one: hover a message → **Reply** (the reply arrow). The box shows *"Replying to …"* and is ready to type (× or Escape cancels). Your message is posted at the bottom of the chat, with the quote of the original right above it.
2. **No threads.** Every reply is in the main chat; there is no side panel. **Viewing as: Maya S.**, open **TechNusa Developer Conference → #design**: her answer to Kevin's deadline question is a quoted reply too.
3. Hover any message to see its toolbar:
   - **React** (emoji);
   - **Reply** (quoted, at the bottom of the chat);
   - **Create task from message**, which pre-fills a new task and posts a link back to it;
   - **Edit / Delete**.
4. **Edit and delete rules:**
   - Authors can edit or delete their own message for **15 minutes**.
   - The **PM can delete any message**.
   - A deleted message leaves a "message deleted" placeholder.

**Try two tabs side by side:** view as two different people and chat between them.

### 4.5 Direct messages and calls
1. **Direct messages.** In the **Oscenia** server, under **Direct messages**, click **+** (*New message*) and find a teammate. Or click the message icon next to a person in the member list.
   - The header says *"Direct message — only the two of you can see it"*.
   - Seeded: **Agus P. ↔ Rina M.** and **Dinda A. ↔ Rina M.**
   - Privacy: **Viewing as Hendra T.**, open `/erp/chat/dm-M-01-M-05` (Agus ↔ Rina). It says *"You can't see this conversation"*. Not even the PM can open someone else's DM.
2. **Calls (simulated).** **Viewing as: Agus P.**, open **Aurora Bank Annual Gala → #general** and click the **video** (or **phone**) icon in the header.
   - Teammates join automatically. Try **Mute**, **Turn camera off**, **Share screen** (the tile shows *"Agus P. is presenting"*) and **Leave**.
   - In a second tab, **viewing as Yoga K.** in the same channel, a banner shows *"Video call in progress · … in the call"* with **Join**. The channel list shows a green phone icon.
   - When the call ends, the channel logs it, e.g. *"Video call · 18 min · Dinda A., Rina M., Hendra T."* (a seeded one is in #general on 24 Jul).
   - A call from a DM is one-to-one; from a channel it is a group call.
3. **Voice channels.** Click **Meeting room** under *Voice channels* (or **Lounge** in Oscenia) to start a call there, or to join the one already running.
   - The people on the call are listed under the channel.
   - The call is logged in the project's **#general**. Lounge calls are logged in the company **#general**.
   - **Back to chat** (top right of the call) keeps the call running while you read. The panel bottom-left then shows *Voice connected* with ↗ (back to the call) and a hang-up button. On a phone, a green bar at the top does the same.
   - Only one call runs at a time. While one is going, other voice channels are greyed out.

There is no real audio, video or screen picture in the prototype. That needs a calling service on the backend.

### 4.6 Who may join a channel (and asking to join)
1. **Locked channels.** **Viewing as: Rina M.**, open **Aurora Bank Annual Gala**. **#production** is greyed with a 🔒: it is for the Production division.
   - Click it. You see *"#production is locked"*, and its messages stay hidden.
   - Her request from 25 Jul is already waiting (*Request sent*).
2. **Ask to join.** **Viewing as: Nadia R.** Open #production, type why you need it (optional), and press **Request to join**.
3. **Decide.** **Viewing as: Hendra T.** (Production lead). The 🔔 bell shows *"Rina M. wants to join #production"* and the same for Nadia.
   - Click it. **Channel settings** opens with both requests: ✓ **Approve** or ✕ **Decline**.
   - Approved people can open the channel straight away. Each requester gets a notification of the answer. After a decline, they can ask again.
4. **Channel settings** (server ▾ → *Channel settings*, or the ⚙ that appears when you hover a channel). Open to the PM, and on a project to the leaders whose division works on it. Company channels are the PM's.
   - **Who can join:** *Everyone on the project*, *Selected divisions*, or *Invite only*.
   - **Also let in / Members:** named people.
   - **Blocked:** kept out whatever the rule says. The PM can't be blocked, and a blocked person loses any say over the channel. Blocking someone also drops them from a call in that channel.
   - **Show it locked…:** untick to hide the channel completely from people who can't open it, like #leaders.
5. **Create a channel.** **Viewing as: Dinda A.**, in Aurora Gala, open server ▾ → **Create channel**. Choose *Text* or *Voice*, name it (e.g. *venue walk* becomes **#venue-walk**), pick who can join, and press **Create channel**.
6. **Try it:** **Viewing as Hendra T.**, block **Yoga K.** from #general. Then **viewing as Yoga K.**, #general is gone from his list.

### 4.7 Meeting records and minutes (MOM)
Every call that ends becomes a **meeting record**.

1. **Restricted minutes.** **Viewing as: Yoga K.** Open **Aurora Gala → #general**. The 24 Jul video call shows 🔒 *"Minutes restricted"*: Yoga was not on the call.
2. **Reading the minutes.** **Viewing as: Dinda A.** (she hosted it). Click **Minutes** on the same line. A panel opens with four tabs:
   - **Summary & MOM:** attendees, date and length, overview, agenda, discussion, decisions, and action items with owner and due date. Use **Copy MOM**, **Download MOM (.md)** and **Create tasks from action items**. Tasks follow the usual assignment rules and are never created twice.
   - **Transcript:** what was said. Simulated, like the call.
   - **Files:** files shared during the call.
   - **Access** (host and PM only):
     - **Who can read** the minutes: *people on the call*, *everyone in the channel*, or *people on the call plus named people*.
     - **Files view-only:** others see the file names but can't open them.
   - Set it to *Everyone in the channel* and save. **Viewing as Yoga K.**, the line now shows **Minutes**.
3. **Notes and files during a call.** In any call, press 📝 **Notes & files**. Type notes and drop in files. Both are saved with the meeting.
4. **Generate the minutes.** **Viewing as: Maya S.** Open **TechNusa Developer Conference → #design**, click **Meeting record** on the 25 Jul call, then **Generate AI summary & MOM**.
   - After a moment the minutes appear, labelled *"Demo AI summary — simulated, no AI service connected"*.
   - Switch the app to **Bahasa Indonesia** first to get them in Bahasa.
5. **Post summary to channel** is offered only when the minutes are open to the whole channel, so posting can't show them to anyone the host kept out.
6. **Privacy rules:**
   - The PM reads the minutes of every channel call, but **never** those of a call in a direct message.
   - Someone who can't open the channel never sees the minutes, whatever the access setting.

---

## 4b. Notifications (the bell)

The **🔔 bell** in the top bar shows what needs the current person's attention. The red number is how many are unread.

1. **Viewing as: Agus P. (PM)** in Workspace or Chat, then click the bell. **Needs your approval** items are pinned at the top: tasks waiting for the PM's final sign-off.
2. Below them, newest first:
   - **Assigned to you:** a task someone handed to this person, still open.
   - **Mentioned you:** an @mention in a channel this person can open.
   - **Blocked:** a task this person handed out has been blocked, with the reason (the PM hears about every blocked task).
   - **Sent back** and **Approved:** their own task was rejected (with the comment) or given final approval.
   - **New RSVP / RSVP declined:** the latest replies for upcoming events, for logins that run events.
   - **Time to reach out / Birthday / Company anniversary:** CRM items due within a week, overdue nudges included.
3. **Click any item** to open the exact task, chat channel, event guest list or client page, and mark it read. **Mark all read** clears the badge.
4. **Try it end to end:**
   - As **Nadia R.**, post `@Rina M.` in *Aurora Bank Annual Gala → #general*.
   - Switch to **Rina M.**: the bell count goes up and shows *Mentioned you*.
   - As **Maya S.**, approve a Design task: it leaves Maya's bell and appears in the PM's as *Needs your approval*.
5. **Privacy:** a mention in a channel someone can't open (e.g. private #leaders) never reaches their bell.

Notifications follow the **Viewing as** person, so switch persona to see someone else's. They are in-app only in the prototype; push, WhatsApp or email alerts come with the backend.

---

## 5. Events & Invitations

Open **Events & Invitations** in the sidebar. There are three events:

- **Aurora Bank Annual Gala 2026:** upcoming (14 Aug), published on the **Gala** template, RSVPs open. The invitations already went out to the whole list.
- **Meridian Rose Collection Launch:** already held (30 Jun), on the **Launch** template. Use it to see a finished event.
- **Wibowo–Sari Wedding:** a draft (5 Sep) with **no template yet**. Use it to walk the whole flow, from the client's first click to the guest's QR code.

Invitations work like an online invitation service. The client picks a designed template and fills it in with their own words, photos, video and music. Oscenia checks it and publishes it, and each guest gets **their own link**.

> **Tip:** use two browser tabs side by side, one for Oscenia staff (the ERP) and one for the client's link. Changes in one tab show in the other straight away.

### 5.1 Design the invitation (staff and client)

**1. Create the event.** Click **New event**, fill in the name, client, date, time and venue, and press **Create & design**. It starts as a draft, on the template gallery.
- **A client who isn't in the list yet:** open the **Client** dropdown and pick **+ New client** (the last option). Fill in **New client name** (contact person and phone are optional) and press **Add client**. The new client is selected, and it also appears in the CRM client list.

**2. Send the client their link.** On the event page, **Client link** copies a private link. The client opens it **without logging in**. It shows the same gallery and editor, without the rest of the ERP.
- To try it, open one of these in a second tab:
  - the wedding: `/erp/invite/EV-03/edit?key=wibowo-5h2m`
  - the Gala: `/erp/invite/EV-01/edit?key=aurora-7f2k`
- **Revoke** makes a new link and stops the old one at once (the old link shows *"This link is not valid"*).
- Only the CEO and the PM can revoke the link or publish.

**3. Choose a template.** The gallery has six built-in designs in two families, plus any your design team has added (see [Your own designs](#your-own-designs-template-studio) below):

| Corporate | Wedding & private |
|---|---|
| **Gala:** midnight and gold, framed like an engraved card | **Royal:** ornamental florals and script names |
| **Launch:** bold and video-first, for reveals and product nights | **Minimal:** quiet white space and a fine serif |
| **Summit:** clean, with room for an agenda and speakers | **Garden:** soft pastels and leaf sprigs |

- The pills filter by family. Each card shows the template's real cover. Your design team's templates carry a **Design team** badge.
- **Live preview** opens the full invitation with sample content, in a phone or desktop frame.
- **Use this template** opens the editor.
- **Change template** (in the editor) brings you back here at any time. Everything already written and uploaded is kept.
  - Sections the new template doesn't use are set aside (*"Kept but not shown in this template"*). They come back with a template that has them.

**4. Fill it in.** The left side lists the template's sections. The right side is the **live preview** (🖥 / 📱).
- Each section has an on/off switch and a form. *Cover*, *Date & venue* and *RSVP* are always on. An empty section is marked *"empty — hidden from guests"*.
- The sections every template has:
  - **Cover** and **Welcome message**;
  - **Countdown**, with Add to calendar;
  - **Date & venue**, with **More sessions** (e.g. a ceremony in the morning and a reception in the evening), each with its own venue and map link;
  - **Gallery**, **Video** and **Dress code**;
  - **RSVP & QR access card**, and **Wishes**.
- Corporate templates add **Hosts & sponsors** (logos), **Agenda** and **Speakers**.
- Wedding templates add **Couple** (with parents and Instagram), **Our story** (a timeline) and **Gifts** (bank or e-wallet accounts with a copy button, and a delivery address).
- **Photos** (cover, gallery, couple, speakers, logos) are shrunk and saved.
- **Video:** paste a YouTube or Vimeo link, or upload an MP4, MOV or WebM file up to 200 MB.
- **Background music:** choose one of three built-in tracks (**Listen** plays it), or upload your own MP3 or M4A, up to 20 MB. It plays when the guest opens the invitation.
- **Accent colour** changes the template's highlight colour. **Reset** goes back to the template's own.
- Changes save as you type. Try it as the client: on the wedding, pick **Royal**, fill in the couple, then upload a few photos and a short video.

**5. RSVP settings (staff only).** Under the sections, **RSVP settings** holds what the client's link cannot change. These apply straight away, without publishing:
- the event's name in the ERP, the **RSVP closing date**, and the **Feedback form link (for follow-ups)** used by the thank-you message after the event (§5.5);
- whether to ask email, allergies and number of people, and the maximum party size (**up to 50 people per invitation**). Name and phone are always asked, and a marketing-consent box always appears, unticked.
  - Above 10, the guest gets a **− / +** counter instead of a dropdown. Try it: set *Up to __ people per invitation* to **20**, then open the invitation as a guest.
- **Your questions:** add your own questions, up to 10 per event.
  - Types: **Short text**, **Multiple choice** (optionally *Allow several answers*) or **Dropdown** (one option per line).
  - Each can be **Required**, and asked of everyone or **Only guests who accept**.
  - The Gala already has three: *Meal preference* (dropdown: Beef / Fish / Vegetarian, required), *Will you take the shuttle from Senayan?* (Yes / No) and *A song you would love to hear* (text).
  - Removing a question hides it from guests but keeps the answers already given.

**6. Submit for review (client).** The bar at the bottom of the client's page shows where the invitation stands.
- The client presses **Submit for review**. The bar then says *"Oscenia is reviewing your invitation"*.
- The client can keep editing while Oscenia reviews; Oscenia sees the latest version.

**7. Review and publish (staff).** Guests only ever see what Oscenia publishes.
- The bell shows **Invitation to review**, pinned to the top. The event page shows a **Waiting for review** badge.
- **Review & publish** (or **Review changes** on a live invitation) opens the review panel. It lists what guests will see change, e.g. *"Cover: edited"*.
- **If the client changed the date**, the panel shows the new date and **which reminders move**. Once published, the reminders, the check-in day and the report all follow the new date.
  - If the RSVP would then close after the event, a tick box moves the RSVP deadline to the event date.
- **Publish** puts the invitation live.
- Or **Send back to the client** with a note (e.g. *"Please use the formal names of the parents"*). The client's bar shows the note, and they press **Send again for review** when ready.
- **Edits to a live invitation stay a draft.** Try it on the Gala: change the cover title from the client's link.
  - The guest page keeps the old title, and the ERP shows **Unpublished changes**.
  - Guests see the new title only after **Publish changes**.
- **Unpublish** takes the invitation down. Guests can no longer open it or RSVP.

#### Your own designs: Template Studio

Your design team (CEO and PM logins) can add templates of their own design to the gallery.
1. Open **Events & Invitations → Invitation templates** in the sidebar, or **Templates** on the Events page.
2. **Duplicate** one of the six built-ins, or start a **New wedding design** or **New corporate design**.
3. In the editor, set the name and tagline, four colours, the heading, body and script fonts, the cover layout and the ornament, and the section order and which sections start on.
   - **Artwork:** cover artwork (used when the client has no cover photo), a page texture, a cover frame (a transparent PNG) and an ornament.
   - The preview on the right shows the design with sample content, on a phone or desktop. **Save** keeps the settings; artwork saves as it is uploaded.
4. **Add to gallery.** The template appears in every event's gallery, and on the client's link, with a **Design team** badge. **Take out of gallery** makes it a draft again.
5. **Archive** instead of delete: the template leaves the gallery, but invitations already using it keep their design. **Show archived → Restore** brings it back as a draft.
- Editing a template that published invitations use shows a warning: their guests see the change as soon as you save.
- **Limits (prototype):** templates and artwork are saved **in this browser only**, so the designer, staff and client need the same browser. In another browser, an invitation on a studio template draws as **Gala**. A new cover layout or a new kind of section still needs a developer.

### 5.2 Send the invitations

Invitations can be sent once the invitation is published.
- The guest list is the client's file, which Oscenia imports (**Guests & RSVP → Import CSV**, §5.4). The client does not upload contacts.
- Each guest gets **their own link**. It opens the invitation with their name on the cover, their RSVP and their QR code.

**Oscenia sends them (event → Send invitations tab):**
1. The counts at the top: on the guest list, invited, sent by Oscenia, sent by the client, and not invited yet.
2. Choose **WhatsApp**, **Email** or **WhatsApp + email**, then edit the email subject and the message.
   - The chips `{name} {link} {event} {date} {venue}` insert placeholders.
   - `{link}` is required, because it becomes each guest's own link.
3. **Send to:** all guests, **Not invited yet**, or a category (VIP, Media, Regular, Vendor). Each option shows how many guests it reaches.
4. The **Preview** shows the WhatsApp message and the email for any guest, filled in with that guest's own link.
5. **Send now**, or **Schedule** a date and time.
   - The demo stays on one day, so a scheduled batch waits, with **Send now** and **Cancel**. With the backend, it sends automatically.
6. **Sent and scheduled** lists every batch. **Show recipients** gives each guest's status per channel: *Sent*, *Delivered*, *Read* or *Failed*, with the reason.
   - On the Gala, the 20 Jul batch has one failure: **Laras Kusuma** has no email address. Type an email in the **Add email** box on her row, then press **Retry failed**.
7. Try the whole thing on the wedding: publish it, import the sample CSV from §5.4, then send to **Not invited yet**.

**The client sends them (client link → Send invitations tab):**
1. Once the invitation is published, the client's page gets a second tab, **Send invitations** (e.g. `/erp/invite/EV-01/edit?key=aurora-7f2k&tab=send`).
2. The client edits their message, then presses **WhatsApp** on a guest's row.
   - WhatsApp opens with the message typed in, with that guest's own link. The client presses send there.
   - The guest is marked **Sent by you**.
3. **Copy message** copies one guest's message, and **Copy all links** copies every guest's name and link, one per line. The ✓ button marks a guest the client reached another way.
4. In the ERP, the same guests show **Sent by client**.

### 5.3 The guest's invitation
1. Open a personal link (no sign-in needed):
   - Dewi Wijaya (VIP, attending): `/erp/invite/EV-01?g=7wdrqp`
   - Bella Rahman (not replied yet; the form opens already filled in): `/erp/invite/EV-01?g=1osq1z`
   - **Open as guest** on the event page opens the general link, without a name.
2. **The cover** greets the guest by name (*"Dear Dewi Wijaya"*). **Open invitation** reveals the page and starts the music (the Gala plays *Warm strings*). The round button pauses and plays it.
3. **Countdown** to the event, and **Add to calendar**. It downloads a calendar file (.ics) that opens in Google Calendar, Outlook or the phone's calendar, with the guest's own link in it.
4. **Date & venue**, with a map button for each session, then the template's other sections.
   - Tap a **gallery** photo to see it full screen (swipe or use the arrows; Esc closes it).
   - On a wedding, the **Gifts** copy buttons copy the account number.
5. **RSVP:** fill in name and phone (already filled in from a personal link). Choose **Joyfully accept**, pick the number of people, add an allergy, and optionally tick the **marketing consent** box.
   Answer the Gala's own questions too. A required one left blank shows *"Please answer: …"*.
6. Press **Send RSVP**. The guest gets a **personal QR code** for the registration desk. **Change my reply** lets them update their answer until the RSVP closes.
7. **Coming back later.** Opening the invitation again on the same device goes **straight to the confirmation and QR**.
   - *"Not [name]? Reply for someone else"* lets another person use the same phone.
   - *"Your personal link"* (with **Copy**) opens that guest's reply and QR on **any** phone.
8. **Wishes:** the guest writes a wish, and it shows on the invitation straight away. A guest with a personal link signs with their listed name.

> The Meridian invitation (`/erp/invite/EV-02`) shows how a **closed RSVP** looks after an event.

**Moderating wishes (staff or client):** in the editor, open the **Wishes** section.
- Every wish is listed, newest first. **Hide** takes one off the invitation; it stays on record, and **Show again** puts it back.
- **Hold wishes for approval:** new wishes then wait (*Waiting for approval*) until someone presses **Approve**. Switching it off shows the waiting ones.
- This applies straight away; there is no need to publish.

**On the day,** the guest's QR code is scanned at **Check-in** (§5.6).

> **Prototype limits for invitations:**
> - **Uploads are saved in this browser only.** Photos, video and music stay in this browser: both tabs see them, and they survive a reload. On another phone or computer they are missing (a video says it was uploaded in another browser). A YouTube or Vimeo link works everywhere. With the backend, uploads are stored for every guest.
> - **Sending is simulated.** No WhatsApp or email message actually goes out, and the delivery statuses are made up. Real sending needs a WhatsApp Business API provider and an email service on the backend. (The client's **WhatsApp** button does open WhatsApp, because that is the client's own phone.)
> - **The built-in music tracks are placeholders**, generated in the browser. The backend will use licensed tracks.
> - The guest's invitation is in English only.

### 5.4 Guests & RSVP (staff view)
1. Go back to the first tab and open the **Guests & RSVP** tab. **Your RSVP is already there.** It is marked *Not on the client's list*, because you are not on the Aurora list.
2. The counts at the top: invited, attending, declined, no response, total people, guests with allergies.
3. **Filters:** Attending / Declined / No response / Not on the list, plus a search box.
4. **Table:** type any table per guest, e.g. *T1*, *VIP-1* or *Garden 3* (up to 30 characters). Suggestions list the event's tables and every table already typed for this event. It saves on Enter or when you click away; Esc puts the saved value back.
5. **Category:** each guest is **VIP**, **Media**, **Regular** or **Vendor**. Change it in the row. The **Category** pills filter the list, with counts (Gala: *VIP · 6, Media · 3, Regular · 21, Vendor · 1*), and the search box matches categories too. The category also shows at check-in and in the report.
6. **Answers to your questions:** the box **Answers from guests attending** tallies them for catering (Gala: Beef 7, Fish 8, Vegetarian 4; shuttle Yes 7, No 12), and each question has its own column.
7. **Personal link:** the link icon at the end of each row (**Copy personal link**) copies that guest's own invitation link (§5.3).
8. **Add guest**, **Import CSV** (see sample below) and **Export**. The export includes category, answers, personal link and internal notes.

Sample CSV (header row optional; commas or semicolons both work):
```csv
name,phone,email,table,category
Budi Santoso,0812 1111 2222,budi@example.com,T1,VIP
Sari Dewi,0813 3333 4444,,T2,Media
```
Phones already on the list are skipped, so importing the same file twice adds nobody.

### 5.5 Reminders
1. Open the **Reminders** tab. Aurora has three rules before the event:
   - **D-10:** guests who haven't replied;
   - **D-7:** attending guests, by WhatsApp;
   - **D-3:** attending guests, by WhatsApp and email.
2. …and one **after** the event: **D+1**, a thank-you to **Guests who came**, with the feedback-form link (*"Thank you for joining us at {event}, {name}! We would love to hear how it went: {feedback}"*). It is switched off until you tick **Active**.
3. For each rule you can change:
   - **Before the event** or **After the event**, and how many days (D-n / D+n);
   - the audience: before the event *Guests attending* / *Guests who have not replied*; after it *Guests who came* / *RSVP'd but did not come*;
   - the channel (WhatsApp / Email / both);
   - the message, using the placeholders `{name} {event} {date} {venue} {link} {feedback}`. A **live preview** shows the result.
     - `{link}` is each guest's personal link. `{feedback}` is the **Feedback form link** from Invitation → RSVP settings. A warning appears if that link is missing.
4. **Send now** records a simulated send in the **Send log**, with the number of recipients. A follow-up cannot be sent before the event (it shows *"Sends after the event"*).
5. **Add reminder** creates a new rule; **Add follow-up (after the event)** creates a D+n one.
6. On **Meridian** (already held), the D+1 thank-you has run: the Send log shows *"D+1 follow-up · 21 · came"*.

### 5.6 Check-in on the day
1. Open the **Check-in** tab. The desk opens for the demo even though the event is on 14 Aug.
2. **Choose the checkpoint.** In the bar at the top, **Scanning at** sets where this device is. Aurora has **Main Entrance**, **VIP Lounge** (VIP only) and **Goodie Bag**. Each device remembers its own choice, so the lounge tablet stays on the lounge.
   - **Checkpoints** (button on the same bar) lets you rename, add or remove them, and tick categories to restrict one (none ticked = everyone).
3. Click **Scan QR**. The camera is simulated: tap one of the guests' QR codes. Or search by **name or phone** in the box next to the button.
4. The guest card shows **Category**, **Table**, **People**, **Allergies** and their answers (e.g. *Meal preference: Beef*). The table can be typed here too (free text, same suggestions as the guest list). If you scan the next guest while typing, what you typed is saved for the guest you were typing it for. Click **Check in at [checkpoint]**.
5. **Warnings (staff can still let the guest in):**
   - At **VIP Lounge**, search **Fitri** (a Regular guest): *"VIP Lounge is for VIP guests. This guest is Regular."* The button becomes **Let in anyway · VIP Lounge**.
   - Check **Dewi Wijaya** in at Main Entrance, then find her again: *"Already scanned here at [time]."* The button becomes **Log again at Main Entrance**.
   - The same guest can be scanned at each checkpoint (entrance, then goodie bag), and each scan is logged.
6. **Scan log:** every scan with time, checkpoint and guest, filter pills per checkpoint, and **Export** (CSV). Meridian already has 37 scans: *Main Entrance · 21, Goodie Bag · 16*.
7. **Walk-ins:** the right panel shows the **Walk-in QR** for the desk. Click **Open the walk-in form** (or go to `/erp/walkin/EV-01`) and register a new person.
   - They are checked in as a **Walk-in** and added to the CRM if they tick consent.
   - Someone already on the list is simply checked in, not duplicated.
8. The counters show **Arrived**, **Expected (RSVP yes)**, **People arrived**, **Walk-ins** and **Scanned at [checkpoint]**. **Recent arrivals** lists the latest.

### 5.7 Attendance report
1. Open **Meridian Rose Collection Launch** → **Attendance report**.
2. The four boxes:

   |  | Came | Did not come |
   |---|---|---|
   | **RSVP'd yes** | 16 | 4 |
   | **No RSVP / declined** | 5 (incl. 3 walk-ins) | 6 |

3. Click any box to list the people in it, and use **Export all** to download a CSV (with category, checkpoints visited and internal notes).
4. **Internal notes:** in **RSVP'd, did not come**, each guest has an **Internal note** field. Type a reason or follow-up and click away to save it; it shows who wrote it and when.
   - Already noted: **Elsa Nugroho** (flight delayed, send the launch kit by courier) and **Fajar Setiawan** (sick on the day, offer a private preview).
   - Notes also show under the guest's name in Guests & RSVP. Guests never see them.
5. The Aurora report explains that it fills in on event day.

---

## 6. CRM & Clients

Open **CRM & Clients** in the sidebar. It now has three tabs.

### 6.1 Clients (existing) + "Coming up"
The top card lists the next three things to act on, overdue first. For example:
- TechNusa's *Product Launch* nudge (overdue);
- **Ibu Ratna**'s birthday in 2 days;
- **Bpk. Wibowo**'s birthday.

**Full calendar →** opens the calendar tab.

### 6.2 Guest contacts — one list from every event
1. Open the **Guest contacts** tab. The **62 guest records** from both events become **40 contacts**, because people who came to both events are merged by phone number. (Any RSVP or walk-in you added in section 5 adds one more.)
2. Each contact shows which events they came to (✓ = attended) and their **marketing consent**, with the date and which event it came from.
3. Filters: **Consented only**, **Attended**, and a choice of event.
4. **Choose who gets a campaign.** Tick the box on each contact, or the box in the header to tick everything the current filters show.
   - The bar above the list shows *"[n] selected"*, and *"[n] without marketing consent — they will be skipped"*. **Clear** unticks all.
5. **Compose campaign · [n]** sends only to the **ticked contacts who gave consent**. The pop-up names anyone skipped for lack of consent. Sending is simulated.
6. **Campaigns (simulated)** records each send: recipients, and how many were skipped.

### 6.3 Relationship calendar — when to get in touch
1. Open the **Relationship calendar** tab and choose **Next 30 / 60 / 90 days**.
2. **Event nudge:** Oscenia learns when each company usually holds an event and reminds staff ahead of it. For example:
   - Aurora Bank holds a *Year-end Town Hall* every **November**, so the nudge is **1 Aug**, 3 months ahead.
   - TechNusa's *Product Launch* nudge is already **overdue**.
3. **Birthdays** of the people we work with, and **company anniversaries**.
4. Buttons:
   - **Log outreach** marks the nudge as done and adds a *Call* entry to the client's history.
   - **Send greeting** is a simulated WhatsApp/email greeting, once per person per occasion per year.
5. **Month view.** Switch from **List** to **Month**. July 2026 shows event nudges, birthdays, company anniversaries and events in colour; click a day to see what's on it.
6. **Google Calendar (simulated)** has its own page: **CRM & Clients → Google Calendar** in the sidebar, or the **Google Calendar** button at the top of CRM (**Open Google Calendar** on this tab goes there too). It is one connection, so the page and the card in this tab's month view always agree.
   - Click **Connect Google Calendar**. A stand-in for Google's sign-in asks for a Google account (any email address works), then **Allow**.
   - The team's Google events now show **in blue** beside the CRM dates, e.g. *Lunch with Ibu Ratna (Aurora Bank)* on 28 Jul and *Site visit — Ritz-Carlton ballroom* on 30 Jul.
   - Options: **Show my Google events here**, and **Add CRM dates to my Google Calendar**. **Disconnect** removes the link.

### 6.4 Client 360 — the relationship view of one client
1. In the **Clients** tab, click **Aurora Bank**. Three new cards appear under the numbers:
   - **People we work with:** Ibu Ratna and Pak Surya, with roles, contacts and birthdays. Click **+** to add a person (birthday as `MM-DD`, e.g. `09-01`), and choose whether they get an automatic birthday greeting and by which channel.
   - **Event cycle:** *Annual Gala* (usually August) and *Year-end Town Hall* (usually November), each with the next nudge date. Change "Nudge __ months before" to move it. After **Log outreach** it shows **Contacted**, with the note.
   - **Greetings:** the company anniversary (1 Mar 2019), whether it is sent automatically and by which channel, a message preview, and the log of greetings sent.
2. The existing **Interaction History** further down also shows the logged outreach.

---

## 6b. Purchase Orders — the pipeline board

Open **Purchase Orders** in the sidebar, and switch from **Table** to **Pipeline**. The same board is also a tab in Vendors: **Vendors → PO pipeline** (§6c).

1. **Five columns**, each with a count and total: **PO Issued → DP Paid → In Progress → Delivered / Completed → Fully Paid**. Each card has a **five-step progress strip**, so you can see how far the order has got. An order with no down payment shows the DP step as skipped.
2. Where the demo orders sit:

   | PO | Vendor | Column |
   |---|---|---|
   | PO-3004 | Bloom & Co (Wedding) | PO Issued |
   | PO-3003 | SoundForge (Conference) | In Progress (delivery in progress) |
   | PO-3001, PO-3002 | Lumina LED, StageWorks (Gala) | Fully Paid |

3. **Delivery status** is separate from the payment status. Change it with the **Delivery** dropdown on a card: *Not started*, *In progress* or *Delivered*. The card shows who changed it and when, and the order moves along the board.
4. **Payment buttons** on the cards (pay DP, settle) are the same actions as in the table. Each opens the posting pop-up first (round 4): check or edit the dates, account, tax and lines, then confirm. A fully paid order sits in **Fully Paid** whatever its delivery status.
5. Draft and cancelled orders are under **Drafts & cancelled** below the board (e.g. PO-3005, a draft you can **Approve**).

In the prototype the delivery status is kept in your browser; with the backend it becomes part of the purchase order.

---

## 6c. Vendors — vendor lifecycle and PO pipeline

Open **Vendors** in the sidebar. It has three views: **Vendors** (the table), **Vendor lifecycle** (called *Pipeline* until round 3) and **PO pipeline**. Switch to **Vendor lifecycle**.

1. **Four stages**, with counts: **Prospect → Onboarding → Approved → Active**. Vendors *On hold* or *Blacklisted* are listed below the board.
2. **Onboarding checklist** (shown on the card as e.g. *3/5*):
   - Read from the vendor record: NPWP, bank account and holder, PIC with phone or email.
   - Ticked by hand: signed MoU (or an attached agreement), and the reference check.
3. **Moving a vendor on:**
   - **Start onboarding:** anyone who can see Vendors.
   - **Approve:** needs the checklist complete, and a finance or CEO login. A PM may tick items but not approve.
   - **Active:** comes with the vendor's first live purchase order.
   - **Put on hold** and **Blacklist** (⋯ menu) need a reason. On hold returns the vendor to where it was. A blacklisted vendor goes back to Onboarding when reactivated.
4. **Only Approved or Active vendors** can be picked for a new purchase order, or have a draft PO approved.
5. In the demo, **BrightRig** is in Onboarding at 3/5. A new vendor starts as **Prospect** and is kept after a refresh. **Vendor 360** (click a vendor) shows its stage, checklist and history.
6. **PO pipeline** shows the purchase-order board from §6b inside Vendors: the five stages, the progress strip, the **Delivery** dropdown and the payment buttons.

---

## 7. Other things to try

- **Language:** use the language toggle in the top bar to switch the ERP to **Bahasa Indonesia**.
- **Deep links:** any event tab can be opened directly, e.g. `/erp/events/EV-01?tab=checkin`. Same for the CRM, e.g. `/erp/crm?tab=calendar`, and for Vendors, e.g. `/erp/vendors?view=po`.
- **On a phone:** every screen works at phone width (checked at 390 px, iPhone size).
  - The menu opens from ☰. In Chat, ☰ in the chat header opens the servers and channels as a drawer, and the meeting panel fills the screen.
  - The guest pages (invitation, RSVP, walk-in) are designed for phones first.
- **Start over:** in **Workspace & Tasks**, the ↺ button next to *Viewing as* restores all demo data (workspace, chat and meetings, events, CRM, purchase-order delivery, vendor stages, studio templates, and added clients and vendors) in every open tab.

---

## 8. Good to know

| Topic | In the prototype | With the backend (after sign-off) |
|---|---|---|
| **Where data lives** | In **your browser only**. Your changes are not visible on anyone else's device, and a guest replying from their own phone won't appear on yours. | A shared database; everyone sees the same data live. |
| **Two tabs** | Changes in one tab (e.g. an RSVP) appear in the other tab of the same browser. | Works across devices. |
| **WhatsApp / email** | Simulated: logged, not sent. | Sent through Oscenia's WhatsApp Business account and email. |
| **QR scanning** | Tap a code in the simulated scanner. | Real phone or tablet camera at the desk. |
| **Chat** | Local to your browser. | Real-time between users. |
| **Calls and minutes** | Calls and their transcripts are simulated. The AI summary is a labelled demo. | Real calls through a calling service. Minutes are written by DeepSeek (or OpenAI) from the real transcript. |
| **Sign-in** | Demo accounts, no server. | Real accounts and permissions. |
| **Existing finance screens** | Some save actions show "Not connected to the API". That is expected in this demo. | Fully connected. |

**Trouble signing in?** Click the account name under **Demo accounts** instead of typing, because that fills in the right password. A saved browser password can otherwise get in the way.

---

## 9. Feature checklist (BRD v0.2)

| BRD | Feature | Where to see it |
|---|---|---|
| §2 | All projects: PIC, pending, status, deadline | Workspace → Projects |
| §2 | Where work is blocked and why | Workspace → Blocked & overdue |
| §2 | Who assigned, who received, when, when done | Task drawer → Activity |
| §2.2 | Role-based access (PM / Leader / Staff / Intern) | "Viewing as" · §3.3, §3.6 |
| §2.3 | Two-stage approval (Leader → PM), block reasons, reject comments | §3.4 |
| §2.4 | PM assigns divisions and members to projects | Workspace → Team & access |
| §3 | Project channels, access by project, mentions, task links, replies | Team Chat · §4 |
| §3 | In-app notifications: approvals, assignments, mentions, blockers, RSVPs, CRM reminders | 🔔 bell · §4b |
| §4.1 | Invitation templates (gallery, sections, photos, video, music); client link without login; review & publish | Event → Invitation · §5.1 |
| §4.1 | Send invitations: from Oscenia by WhatsApp/email, or by the client from their own WhatsApp | Event → Send invitations · §5.2 |
| §4.2 | Guest invitation (named cover, music, countdown, calendar, gallery, wishes); RSVP + personal QR | Personal link · §5.3 |
| §4.3 | Guest list vs RSVPs, table assignment, CSV import | Guests & RSVP · §5.4 |
| §4.3 | Configurable WhatsApp/email reminders (D-n) | Reminders · §5.5 |
| §4.4 | QR check-in, walk-in self-registration | Check-in · §5.6 |
| §4.5 | Attendance reconciliation (4 groups) + export | Attendance report · §5.7 |
| §5.1 | Guest contacts from all events, with marketing consent; campaigns to consented only | CRM → Guest contacts · §6.2 |
| §5.2 | Client PICs, event history and cycle nudges, birthday/anniversary greetings | CRM → Relationship calendar, Client 360 · §6.3–6.4 |

**Added after feedback round 1** (see [section 0](#0-whats-new-since-your-feedback-round-1)):

| # | Feature | Where to see it |
|---|---|---|
| W1, W3 | Leaders assign anyone in their division; only the assignee submits | Workspace · §3.4–3.5 |
| W2 | File attachments on tasks | Task drawer → Attachments · §3.8 |
| CH1 | Quoted replies in the main chat (threads removed in round 3) | Team Chat · §4.4 |
| CH2 | Direct messages; group and one-to-one calls, screen share (simulated) | Team Chat · §4.5 |
| E1 | New client from the New event pop-up | Events → New event · §5 |
| R6, R7 | Up to 50 people per invitation; your own RSVP questions | Invitation → RSVP settings · §5.1 |
| R3 | Remembered guest and personal guest links | Guest page, Guests & RSVP · §5.3–5.4 |
| R2 | Guest categories | Guests & RSVP · §5.4 |
| R4 | Follow-ups after the event (D+n), feedback link | Reminders · §5.5 |
| R1 | Multiple checkpoints and a scan log | Check-in · §5.6 |
| R5 | Internal notes on no-shows | Attendance report · §5.7 |
| C1 | Tick contacts for a campaign (consented only) | CRM → Guest contacts · §6.2 |
| C2 | Month calendar and Google Calendar (simulated) | CRM → Relationship calendar · §6.3 |
| V1 | PO pipeline board with delivery status | Purchase Orders → Pipeline · §6b |

**Added after feedback round 2** (see [section 00](#00-whats-new-round-2)):

| # | Feature | Where to see it |
|---|---|---|
| CH3 | Discord-style chat: rail, categories, voice channels, user panel, presence, phone drawer | Team Chat · §4.1, §4.5 |
| CH5 | Who may join a channel; block list; join requests decided by the PM or project leaders | Team Chat → Channel settings · §4.6 |
| CH4 | Meeting records: transcript, notes, files, Summary & MOM, access decided by the host | Team Chat → a call line → Minutes · §4.7 |
| V2 | Vendor lifecycle board with an onboarding checklist | Vendors → Vendor lifecycle · §6c |

**Added after feedback round 3** (see [section 000](#000-whats-new-round-3)):

| # | Feature | Where to see it |
|---|---|---|
| 1 | Google Calendar page (simulated sync) | CRM & Clients → Google Calendar · §6.3 |
| 2 | One Reply: posted at the bottom with a quote; threads removed | Team Chat · §4.4 |
| 3 | PO pipeline tab in Vendors, with a progress strip | Vendors → PO pipeline · §6b–6c |
| 4 | Template Studio: the design team's own invitation templates | Events & Invitations → Invitation templates · §5.1 |

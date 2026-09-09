/**
 * The guided tour, as data.
 *
 * Each step points at something that is really on screen, by the same class
 * the component renders. A step whose target is missing is skipped rather than
 * pointing at nothing — the sidebar collapses, the room only exists once a
 * Workspace does, and a tour that insists on a control the person cannot see
 * is worse than no tour.
 */
export interface TutorialStep {
  id: string;
  /** Quest-style heading. Short enough to read in one glance. */
  title: string;
  body: string;
  /** CSS selector for the element to spotlight. Absent centres the card. */
  selector?: string;
  /** Where the card sits relative to the target. */
  placement?: "right" | "left" | "top" | "bottom";
  /** One line naming what the person can do here, shown as the step's goal. */
  goal?: string;
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: "welcome",
    title: "Welcome to the floor",
    body:
      "This is a place where several AI Agents work together on your project, " +
      "in a room you can watch. Six short stops and you will know your way " +
      "around. You can leave at any time and pick it back up later.",
    goal: "Press Next to begin",
  },
  {
    id: "workspace",
    title: "1 · Build the room",
    body:
      "A Workspace is a shared home: one set of files, one room, and as many " +
      "Conversations as you need. Everything else lives inside one.",
    selector: ".create-actions .button-primary",
    placement: "right",
    goal: "New workspace creates it",
  },
  {
    id: "agent",
    title: "2 · Hire your workers",
    body:
      "An Agent is one worker with its own instructions and its own model. " +
      "Give it a job description (or press Draft it for me and have one " +
      "written for you), then put it in a Workspace.",
    selector: ".create-actions .button-secondary",
    placement: "right",
    goal: "New Agent opens the form",
  },
  {
    id: "roster",
    title: "3 · Fill the desks",
    body:
      "Your Agents live here. Each one keeps its own folder and its own " +
      "session, and the same Agent can work in several Workspaces.",
    selector: ".agent-list",
    placement: "right",
    goal: "Click an Agent to open it",
  },
  {
    id: "conversation",
    title: "4 · Give them work",
    body:
      "A Conversation is one task. Pick who joins, describe what you want, and " +
      "they take turns: a supervisor model decides who speaks next. Turn on " +
      "Always clarify first and they will ask you questions before they build.",
    selector: ".thread-list",
    placement: "right",
    goal: "Every Workspace holds its own Conversations",
  },
  {
    id: "room",
    title: "5 · Watch it happen",
    body:
      "The room is the live picture: who is at their desk, who is thinking, " +
      "who walked off to the shelves to search. Point at anyone to read their " +
      "state: the card stays on top so you can compare two of them.",
    selector: ".ws-stage",
    placement: "left",
    goal: "Hover a character to raise its card",
  },
  {
    id: "decor",
    title: "6 · Make it yours",
    body:
      "Ping-pong table, espresso bar, arcade cabinet, office dog. Or switch " +
      "the whole crew to robots if you would rather they just stood at their " +
      "posts. None of it changes what an Agent can do.",
    selector: ".ws-decor-control",
    placement: "left",
    goal: "Room opens the furniture",
  },
  {
    id: "evidence",
    title: "Bonus · Check their work",
    body:
      "Insights shows what every model is costing you. Traces keeps the " +
      "step-by-step record of each run. Roles & skills decides what an Agent " +
      "is allowed to touch: that one is the real safety control.",
    selector: ".shell-nav",
    placement: "right",
    goal: "Three views, one for each question",
  },
  {
    id: "done",
    title: "That is the whole floor",
    body:
      "Create a Workspace, put an Agent in it, and give them something to do. " +
      "You can replay this tour whenever you like from the button at the " +
      "bottom of the sidebar.",
    goal: "Go and build something",
  },
];

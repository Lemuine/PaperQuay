function createNoteCommands(context) {
  const { noteStore } = context;

  return {
    notes_list({ request = {} }) {
      return noteStore.listNotes(request);
    },

    notes_list_all({ request = {} } = {}) {
      return noteStore.listAllNotes(request);
    },

    notes_get({ id }) {
      return noteStore.getNote({ id });
    },

    notes_create({ request }) {
      return noteStore.createNote(request ?? {});
    },

    notes_update({ id, patch }) {
      return noteStore.updateNote({ id, patch: patch ?? {} });
    },

    notes_delete({ id }) {
      noteStore.deleteNote({ id });
    },

    notes_tags({ request = {} }) {
      return noteStore.listTags(request);
    },

    notes_backlinks({ noteId }) {
      return noteStore.listBacklinks({ noteId });
    },
  };
}

module.exports = { createNoteCommands };

/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = pgm => {
  pgm.addColumns('messages', {
    image_url: { type: 'varchar(2048)', notNull: false },
  });
};

exports.down = pgm => {
  pgm.dropColumns('messages', ['image_url']);
};
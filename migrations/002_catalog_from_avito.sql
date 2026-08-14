-- 002_catalog_from_avito.sql — справочник услуг и городов по РЕАЛЬНЫМ данным аккаунта Avito «Услуги 24/7»
-- Источник: Avito API (объявления + 40 отзывов), выгрузка 2026-08-14.
-- Цены взяты только те, что указаны в активных объявлениях. Где цены нет — NULL,
-- и система обязана говорить «стоимость после оценки», а не выдумывать.
-- Идемпотентно.

INSERT INTO cities (slug, name, region, sort_order) VALUES
  ('oktyabrskiy', 'Октябрьский', 'Республика Башкортостан', 1),
  ('tuymazy',     'Туймазы',     'Республика Башкортостан', 2)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO service_categories (slug, name, icon, sort_order) VALUES
  ('zemlyanye',    'Земляные работы',       '⛏',  1),
  ('gruzchiki',    'Грузчики и переезды',   '📦', 2),
  ('raznorabochie','Разнорабочие',          '👷', 3),
  ('demontazh',    'Демонтаж',              '🧱', 4),
  ('master',       'Мастер на час',         '🔧', 5),
  ('uborka',       'Уборка и территория',   '🧹', 6),
  ('spectehnika',  'Спецтехника',           '🚛', 7)
ON CONFLICT (slug) DO NOTHING;

-- Услуги. price_from — из активных объявлений Avito; NULL = цена по оценке объекта.
INSERT INTO services (slug, name, category_id, description, price_from, price_unit, sort_order) VALUES
  ('kopka-transhey',   'Копка траншей вручную',
     (SELECT id FROM service_categories WHERE slug='zemlyanye'),
     'Ручная копка траншей под коммуникации, водопровод, канализацию.', NULL, '', 1),
  ('kopka-septik',     'Копка под септик и колодец',
     (SELECT id FROM service_categories WHERE slug='zemlyanye'),
     'Земляные работы под септик, колодец, выгребную яму. Вручную, там где не пройдёт техника.', NULL, '', 2),
  ('kopka-zemli',      'Копка земли, засыпка, планировка',
     (SELECT id FROM service_categories WHERE slug='zemlyanye'),
     'Ручные земляные работы: копка, засыпка, выравнивание участка.', NULL, '', 3),
  ('gruzchiki',        'Грузчики',
     (SELECT id FROM service_categories WHERE slug='gruzchiki'),
     'Погрузка, разгрузка, подъём на этаж, складские работы.', 800, 'час', 1),
  ('pereezd',          'Переезды',
     (SELECT id FROM service_categories WHERE slug='gruzchiki'),
     'Квартирные и офисные переезды. Грузчики, при необходимости с транспортом.', NULL, '', 2),
  ('raznorabochie',    'Бригада разнорабочих',
     (SELECT id FROM service_categories WHERE slug='raznorabochie'),
     'Подсобные работы на объекте: подача материала, уборка, помощь бригаде.', 500, 'час', 1),
  ('demontazh',        'Демонтаж построек и конструкций',
     (SELECT id FROM service_categories WHERE slug='demontazh'),
     'Снос бань, сараев, гаражей, перегородок, полов, кровли. С сортировкой и погрузкой мусора.', NULL, '', 1),
  ('master-na-chas',   'Мастер на час',
     (SELECT id FROM service_categories WHERE slug='master'),
     'Мелкий бытовой ремонт: повесить, закрепить, собрать, починить.', NULL, '', 1),
  ('uborka-territorii','Уборка территории',
     (SELECT id FROM service_categories WHERE slug='uborka'),
     'Расчистка участка, вывоз мусора, окучивание, прополка, уборка снега.', NULL, '', 1),
  ('uborka-mogil',     'Уборка и обслуживание могил',
     (SELECT id FROM service_categories WHERE slug='uborka'),
     'Комплексная уборка, покраска, ремонт на кладбище.', 1990, '', 2),
  ('manipulyator',     'Манипулятор-длинномер',
     (SELECT id FROM service_categories WHERE slug='spectehnika'),
     'Перевозка длинномерных и тяжёлых грузов с погрузкой манипулятором.', 3500, '', 1)
ON CONFLICT (slug) DO NOTHING;

-- Отзывы с Avito: показываем только как подтверждённые отзывы площадки, со ссылкой на профиль.
-- Заполняются скриптом scripts/import_avito_reviews.mjs — здесь только поля под источник.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS source          TEXT DEFAULT 'site';
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS source_id       TEXT DEFAULT '';
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS source_item     TEXT DEFAULT '';
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS author_name     TEXT DEFAULT '';
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS published_at    TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_source_unique
  ON reviews(source, source_id) WHERE source_id <> '';

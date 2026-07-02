DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.tables
		WHERE table_schema = 'public'
			AND table_name IN (
				'moka_durable_node_record',
				'moka_durable_run',
				'moka_run_control_event',
				'moka_run_control_node_artifact',
				'moka_run_control_node_session',
				'moka_run_control_run'
			)
	) THEN
		RAISE EXCEPTION 'public moka substrate tables must be moved by migratePostgresSubstrate before migration 0002_moka_schema';
	END IF;
END $$;

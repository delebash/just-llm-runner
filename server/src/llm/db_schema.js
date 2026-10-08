// SPDX-License-Identifier: MIT
// Captured 2026-10-08 by the kit's capture-schema tool from the Python server's tables, and
// since then the schema itself (the Python is gone): each table's DDL is the exact text
// Python's create_all wrote to sqlite_master, so old and new databases match cell for cell;
// `columns` carries each column's conversion kind and default. Change a table here.
export const TABLES = [
  {
    "name": "llm_providers",
    "ddl": "CREATE TABLE llm_providers (\n\tid VARCHAR NOT NULL, \n\tname VARCHAR NOT NULL, \n\tkind VARCHAR NOT NULL, \n\tbuilt_in BOOLEAN NOT NULL, \n\tposition INTEGER NOT NULL, \n\tprovider_type VARCHAR NOT NULL, \n\tbase_url VARCHAR NOT NULL, \n\tapi_key VARCHAR, \n\tdefault_model VARCHAR NOT NULL, \n\tembedding_model VARCHAR NOT NULL, \n\ttimeout_seconds INTEGER NOT NULL, \n\tlocal BOOLEAN NOT NULL, \n\tPRIMARY KEY (id)\n)",
    "indexes": [],
    "columns": {
      "id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "name": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "kind": {
        "kind": "text",
        "notNull": true,
        "default": "llm"
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": false
      },
      "position": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "provider_type": {
        "kind": "text",
        "notNull": true,
        "default": "openai-compat"
      },
      "base_url": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "api_key": {
        "kind": "text"
      },
      "default_model": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "embedding_model": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "timeout_seconds": {
        "kind": "int",
        "notNull": true,
        "default": 60
      },
      "local": {
        "kind": "bool",
        "notNull": true,
        "default": true
      }
    }
  },
  {
    "name": "llm_usage",
    "ddl": "CREATE TABLE llm_usage (\n\tid VARCHAR NOT NULL, \n\tat INTEGER NOT NULL, \n\tfeature VARCHAR NOT NULL, \n\tprovider_id VARCHAR, \n\tmodel VARCHAR, \n\tprompt_tokens INTEGER NOT NULL, \n\tcompletion_tokens INTEGER NOT NULL, \n\tcost FLOAT NOT NULL, \n\tmeta TEXT NOT NULL, \n\tPRIMARY KEY (id)\n)",
    "indexes": [],
    "columns": {
      "id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "at": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "feature": {
        "kind": "text",
        "notNull": true,
        "default": "unknown"
      },
      "provider_id": {
        "kind": "text"
      },
      "model": {
        "kind": "text"
      },
      "prompt_tokens": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "completion_tokens": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "cost": {
        "kind": "float",
        "notNull": true,
        "default": 0.0
      },
      "meta": {
        "kind": "text",
        "notNull": true,
        "default": "{}"
      }
    }
  },
  {
    "name": "model_catalog",
    "ddl": "CREATE TABLE model_catalog (\n\tid VARCHAR NOT NULL, \n\tname VARCHAR NOT NULL, \n\thf_repo VARCHAR NOT NULL, \n\tquant VARCHAR NOT NULL, \n\tmmproj VARCHAR, \n\ttotal_params VARCHAR NOT NULL, \n\tactive_params VARCHAR NOT NULL, \n\tmtp BOOLEAN NOT NULL, \n\tmtp_builtin BOOLEAN NOT NULL, \n\tmtp_draft_repo VARCHAR NOT NULL, \n\tmtp_draft_file VARCHAR NOT NULL, \n\tmtp_draft_quant VARCHAR NOT NULL, \n\ttype VARCHAR NOT NULL, \n\ttrained_ctx INTEGER, \n\tmin_vram_mb INTEGER, \n\tmin_ram_mb INTEGER, \n\ttier VARCHAR NOT NULL, \n\tlicense VARCHAR NOT NULL, \n\tuse_limited BOOLEAN NOT NULL, \n\tembedding BOOLEAN NOT NULL, \n\tpooling VARCHAR NOT NULL, \n\tquality_rank INTEGER NOT NULL, \n\tdescription TEXT NOT NULL, \n\tnotes TEXT NOT NULL, \n\tarchitecture VARCHAR NOT NULL, \n\texperts INTEGER NOT NULL, \n\tsize_label VARCHAR NOT NULL, \n\tsize_bytes BIGINT, \n\test_vram_mb INTEGER, \n\tblock_count INTEGER NOT NULL, \n\tn_kv_heads INTEGER NOT NULL, \n\thead_count INTEGER NOT NULL, \n\tembedding_length INTEGER NOT NULL, \n\texpert_used_count INTEGER NOT NULL, \n\texpert_byte_share FLOAT NOT NULL, \n\tkv_windowed_bytes_per_token FLOAT NOT NULL, \n\tkv_global_bytes_per_token FLOAT NOT NULL, \n\tsliding_window INTEGER NOT NULL, \n\texps_bytes INTEGER NOT NULL, \n\tlayers_nonexp_bytes INTEGER NOT NULL, \n\toutput_bytes INTEGER NOT NULL, \n\tbuilt_in BOOLEAN NOT NULL, \n\tposition INTEGER NOT NULL, \n\tPRIMARY KEY (id)\n)",
    "indexes": [],
    "columns": {
      "id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "name": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "hf_repo": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "quant": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "mmproj": {
        "kind": "text"
      },
      "total_params": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "active_params": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "mtp": {
        "kind": "bool",
        "notNull": true,
        "default": false
      },
      "mtp_builtin": {
        "kind": "bool",
        "notNull": true,
        "default": false
      },
      "mtp_draft_repo": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "mtp_draft_file": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "mtp_draft_quant": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "type": {
        "kind": "text",
        "notNull": true,
        "default": "dense"
      },
      "trained_ctx": {
        "kind": "int"
      },
      "min_vram_mb": {
        "kind": "int"
      },
      "min_ram_mb": {
        "kind": "int"
      },
      "tier": {
        "kind": "text",
        "notNull": true,
        "default": "mid"
      },
      "license": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "use_limited": {
        "kind": "bool",
        "notNull": true,
        "default": false
      },
      "embedding": {
        "kind": "bool",
        "notNull": true,
        "default": false
      },
      "pooling": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "quality_rank": {
        "kind": "int",
        "notNull": true,
        "default": 100
      },
      "description": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "notes": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "architecture": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "experts": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "size_label": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "size_bytes": {
        "kind": "int"
      },
      "est_vram_mb": {
        "kind": "int"
      },
      "block_count": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "n_kv_heads": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "head_count": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "embedding_length": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "expert_used_count": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "expert_byte_share": {
        "kind": "float",
        "notNull": true,
        "default": 0.0
      },
      "kv_windowed_bytes_per_token": {
        "kind": "float",
        "notNull": true,
        "default": 0.0
      },
      "kv_global_bytes_per_token": {
        "kind": "float",
        "notNull": true,
        "default": 0.0
      },
      "sliding_window": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "exps_bytes": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "layers_nonexp_bytes": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "output_bytes": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": false
      },
      "position": {
        "kind": "int",
        "notNull": true,
        "default": 0
      }
    }
  },
  {
    "name": "model_samplers",
    "ddl": "CREATE TABLE model_samplers (\n\tmodel_id VARCHAR NOT NULL, \n\tparam_name VARCHAR NOT NULL, \n\tvalue TEXT NOT NULL, \n\tbuilt_in BOOLEAN NOT NULL, \n\tPRIMARY KEY (model_id, param_name)\n)",
    "indexes": [],
    "columns": {
      "model_id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "param_name": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "value": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": false
      }
    }
  },
  {
    "name": "model_embed_templates",
    "ddl": "CREATE TABLE model_embed_templates (\n\tmodel_id VARCHAR NOT NULL, \n\tdocument_template TEXT NOT NULL, \n\tquery_template TEXT NOT NULL, \n\tbuilt_in BOOLEAN NOT NULL, \n\tPRIMARY KEY (model_id)\n)",
    "indexes": [],
    "columns": {
      "model_id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "document_template": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "query_template": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": false
      }
    }
  },
  {
    "name": "model_pricing",
    "ddl": "CREATE TABLE model_pricing (\n\tmodel_id VARCHAR NOT NULL, \n\tinput_per_m FLOAT NOT NULL, \n\toutput_per_m FLOAT NOT NULL, \n\tPRIMARY KEY (model_id)\n)",
    "indexes": [],
    "columns": {
      "model_id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "input_per_m": {
        "kind": "float",
        "notNull": true,
        "default": 0.0
      },
      "output_per_m": {
        "kind": "float",
        "notNull": true,
        "default": 0.0
      }
    }
  },
  {
    "name": "reasoning_map",
    "ddl": "CREATE TABLE reasoning_map (\n\tprovider_id VARCHAR NOT NULL, \n\tlevel VARCHAR NOT NULL, \n\tword VARCHAR NOT NULL, \n\ttokens INTEGER, \n\tbuilt_in BOOLEAN NOT NULL, \n\tPRIMARY KEY (provider_id, level)\n)",
    "indexes": [],
    "columns": {
      "provider_id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "level": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "word": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "tokens": {
        "kind": "int"
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": false
      }
    }
  },
  {
    "name": "switch_presets",
    "ddl": "CREATE TABLE switch_presets (\n\tid VARCHAR NOT NULL, \n\tlabel VARCHAR NOT NULL, \n\tapplies_to VARCHAR NOT NULL, \n\tposition INTEGER NOT NULL, \n\tbuilt_in BOOLEAN NOT NULL, \n\tPRIMARY KEY (id)\n)",
    "indexes": [],
    "columns": {
      "id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "label": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "applies_to": {
        "kind": "text",
        "notNull": true,
        "default": "all"
      },
      "position": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": false
      }
    }
  },
  {
    "name": "routing_configs",
    "ddl": "CREATE TABLE routing_configs (\n\tid VARCHAR NOT NULL, \n\tname VARCHAR NOT NULL, \n\tis_active BOOLEAN NOT NULL, \n\tposition INTEGER NOT NULL, \n\tdefault_llm_id VARCHAR NOT NULL, \n\tdefault_model VARCHAR NOT NULL, \n\tdefault_embedding_id VARCHAR NOT NULL, \n\tdefault_embedding_model VARCHAR NOT NULL, \n\tPRIMARY KEY (id)\n)",
    "indexes": [],
    "columns": {
      "id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "name": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "is_active": {
        "kind": "bool",
        "notNull": true,
        "default": false
      },
      "position": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "default_llm_id": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "default_model": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "default_embedding_id": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "default_embedding_model": {
        "kind": "text",
        "notNull": true,
        "default": ""
      }
    }
  },
  {
    "name": "model_tunes",
    "ddl": "CREATE TABLE model_tunes (\n\tmodel_id VARCHAR NOT NULL, \n\thw_key VARCHAR NOT NULL, \n\tflag_name VARCHAR NOT NULL, \n\tflag_value TEXT NOT NULL, \n\tbackend VARCHAR NOT NULL, \n\tPRIMARY KEY (model_id, hw_key, flag_name)\n)",
    "indexes": [],
    "columns": {
      "model_id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "hw_key": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "flag_name": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "flag_value": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "backend": {
        "kind": "text",
        "notNull": true,
        "default": ""
      }
    }
  },
  {
    "name": "model_tune_baselines",
    "ddl": "CREATE TABLE model_tune_baselines (\n\tmodel_id VARCHAR NOT NULL, \n\thw_key VARCHAR NOT NULL, \n\tflag_name VARCHAR NOT NULL, \n\tflag_value TEXT NOT NULL, \n\tPRIMARY KEY (model_id, hw_key, flag_name)\n)",
    "indexes": [],
    "columns": {
      "model_id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "hw_key": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "flag_name": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "flag_value": {
        "kind": "text",
        "notNull": true,
        "default": ""
      }
    }
  },
  {
    "name": "test_samples",
    "ddl": "CREATE TABLE test_samples (\n\tid INTEGER NOT NULL, \n\taction_key VARCHAR NOT NULL, \n\tlabel VARCHAR NOT NULL, \n\tposition INTEGER NOT NULL, \n\tPRIMARY KEY (id)\n)",
    "indexes": [],
    "columns": {
      "id": {
        "kind": "int",
        "pk": true,
        "notNull": true
      },
      "action_key": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "label": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "position": {
        "kind": "int",
        "notNull": true,
        "default": 0
      }
    }
  },
  {
    "name": "test_sample_vars",
    "ddl": "CREATE TABLE test_sample_vars (\n\tsample_id INTEGER NOT NULL, \n\tname VARCHAR NOT NULL, \n\tvalue TEXT NOT NULL, \n\tPRIMARY KEY (sample_id, name)\n)",
    "indexes": [],
    "columns": {
      "sample_id": {
        "kind": "int",
        "pk": true,
        "notNull": true
      },
      "name": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "value": {
        "kind": "text",
        "notNull": true,
        "default": ""
      }
    }
  },
  {
    "name": "hardware_classes",
    "ddl": "CREATE TABLE hardware_classes (\n\tclass_key VARCHAR NOT NULL, \n\tmem_type VARCHAR NOT NULL, \n\tvram_gb INTEGER NOT NULL, \n\tram_gb INTEGER NOT NULL, \n\tname TEXT NOT NULL, \n\tbuilt_in BOOLEAN NOT NULL, \n\tvram_bw_gbps FLOAT NOT NULL, \n\tram_bw_gbps FLOAT NOT NULL, \n\tPRIMARY KEY (class_key)\n)",
    "indexes": [],
    "columns": {
      "class_key": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "mem_type": {
        "kind": "text",
        "notNull": true,
        "default": "discrete"
      },
      "vram_gb": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "ram_gb": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "name": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": false
      },
      "vram_bw_gbps": {
        "kind": "float",
        "notNull": true,
        "default": 0.0
      },
      "ram_bw_gbps": {
        "kind": "float",
        "notNull": true,
        "default": 0.0
      }
    }
  },
  {
    "name": "class_tunes",
    "ddl": "CREATE TABLE class_tunes (\n\tmodel_id VARCHAR NOT NULL, \n\tclass_key VARCHAR NOT NULL, \n\tflag_name VARCHAR NOT NULL, \n\tflag_value TEXT NOT NULL, \n\tbuilt_in BOOLEAN NOT NULL, \n\tPRIMARY KEY (model_id, class_key, flag_name)\n)",
    "indexes": [],
    "columns": {
      "model_id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "class_key": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "flag_name": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "flag_value": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": false
      }
    }
  },
  {
    "name": "model_measurements",
    "ddl": "CREATE TABLE model_measurements (\n\tid INTEGER NOT NULL, \n\tmodel_id VARCHAR NOT NULL, \n\tmachine_key VARCHAR NOT NULL, \n\tsource VARCHAR NOT NULL, \n\tlabel VARCHAR NOT NULL, \n\ttokens_per_sec FLOAT NOT NULL, \n\tvram_total_mb INTEGER NOT NULL, \n\tat INTEGER NOT NULL, \n\tbackend VARCHAR NOT NULL, \n\tvram_model_mb INTEGER NOT NULL, \n\tkind VARCHAR NOT NULL, \n\trealtime_x FLOAT NOT NULL, \n\tPRIMARY KEY (id)\n)",
    "indexes": [],
    "columns": {
      "id": {
        "kind": "int",
        "pk": true,
        "notNull": true
      },
      "model_id": {
        "kind": "text",
        "notNull": true
      },
      "machine_key": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "source": {
        "kind": "text",
        "notNull": true,
        "default": "tune"
      },
      "label": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "tokens_per_sec": {
        "kind": "float",
        "notNull": true,
        "default": 0.0
      },
      "vram_total_mb": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "at": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "backend": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "vram_model_mb": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "kind": {
        "kind": "text",
        "notNull": true,
        "default": "llm"
      },
      "realtime_x": {
        "kind": "float",
        "notNull": true,
        "default": 0.0
      }
    }
  },
  {
    "name": "measurement_switches",
    "ddl": "CREATE TABLE measurement_switches (\n\tmeasurement_id INTEGER NOT NULL, \n\tflag_name VARCHAR NOT NULL, \n\tflag_value TEXT NOT NULL, \n\tPRIMARY KEY (measurement_id, flag_name)\n)",
    "indexes": [],
    "columns": {
      "measurement_id": {
        "kind": "int",
        "pk": true,
        "notNull": true
      },
      "flag_name": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "flag_value": {
        "kind": "text",
        "notNull": true,
        "default": ""
      }
    }
  },
  {
    "name": "runner_binary",
    "ddl": "CREATE TABLE runner_binary (\n\tplatform VARCHAR NOT NULL, \n\tgpu VARCHAR NOT NULL, \n\tsource VARCHAR NOT NULL, \n\tasset_url VARCHAR, \n\truntime_url VARCHAR, \n\timage VARCHAR, \n\tsha256 VARCHAR, \n\tserver_exe VARCHAR NOT NULL, \n\tbuilt_in BOOLEAN NOT NULL, \n\tposition INTEGER NOT NULL, \n\tPRIMARY KEY (platform, gpu)\n)",
    "indexes": [],
    "columns": {
      "platform": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "gpu": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "source": {
        "kind": "text",
        "notNull": true,
        "default": "github"
      },
      "asset_url": {
        "kind": "text"
      },
      "runtime_url": {
        "kind": "text"
      },
      "image": {
        "kind": "text"
      },
      "sha256": {
        "kind": "text"
      },
      "server_exe": {
        "kind": "text",
        "notNull": true,
        "default": "llama-server"
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": false
      },
      "position": {
        "kind": "int",
        "notNull": true,
        "default": 0
      }
    }
  },
  {
    "name": "runner_setting",
    "ddl": "CREATE TABLE runner_setting (\n\t\"key\" VARCHAR NOT NULL, \n\tvalue VARCHAR NOT NULL, \n\tbuilt_in BOOLEAN NOT NULL, \n\tPRIMARY KEY (\"key\")\n)",
    "indexes": [],
    "columns": {
      "key": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "value": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": false
      }
    }
  },
  {
    "name": "knob_catalog",
    "ddl": "CREATE TABLE knob_catalog (\n\tflag_name VARCHAR NOT NULL, \n\tkind VARCHAR NOT NULL, \n\tdefault_value VARCHAR NOT NULL, \n\thelp TEXT NOT NULL, \n\tplane INTEGER NOT NULL, \n\tapplies_to VARCHAR NOT NULL, \n\ttier VARCHAR NOT NULL, \n\tper_request BOOLEAN NOT NULL, \n\tbackends VARCHAR NOT NULL, \n\tfit_relevant BOOLEAN NOT NULL, \n\tposition INTEGER NOT NULL, \n\tbuilt_in BOOLEAN NOT NULL, \n\tPRIMARY KEY (flag_name)\n)",
    "indexes": [],
    "columns": {
      "flag_name": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "kind": {
        "kind": "text",
        "notNull": true,
        "default": "string"
      },
      "default_value": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "help": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "plane": {
        "kind": "int",
        "notNull": true,
        "default": 1
      },
      "applies_to": {
        "kind": "text",
        "notNull": true,
        "default": "all"
      },
      "tier": {
        "kind": "text",
        "notNull": true,
        "default": "common"
      },
      "per_request": {
        "kind": "bool",
        "notNull": true,
        "default": false
      },
      "backends": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "fit_relevant": {
        "kind": "bool",
        "notNull": true,
        "default": false
      },
      "position": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": false
      }
    }
  },
  {
    "name": "feature_prompts",
    "ddl": "CREATE TABLE feature_prompts (\n\t\"key\" VARCHAR NOT NULL, \n\tfeature VARCHAR NOT NULL, \n\tsystem TEXT NOT NULL, \n\tuser_template TEXT NOT NULL, \n\tjson_mode BOOLEAN NOT NULL, \n\tjson_schema TEXT NOT NULL, \n\tbuilt_in BOOLEAN NOT NULL, \n\tlabel VARCHAR NOT NULL, \n\tdescription TEXT NOT NULL, \n\tsubgroup VARCHAR NOT NULL, \n\tposition INTEGER NOT NULL, \n\tPRIMARY KEY (\"key\")\n)",
    "indexes": [],
    "columns": {
      "key": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "feature": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "system": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "user_template": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "json_mode": {
        "kind": "bool",
        "notNull": true,
        "default": false
      },
      "json_schema": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": true
      },
      "label": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "description": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "subgroup": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "position": {
        "kind": "int",
        "notNull": true,
        "default": 0
      }
    }
  },
  {
    "name": "engine_presets",
    "ddl": "CREATE TABLE engine_presets (\n\tid VARCHAR NOT NULL, \n\tname VARCHAR NOT NULL, \n\tprovider_id VARCHAR NOT NULL, \n\tmodel VARCHAR NOT NULL, \n\ttemperature FLOAT, \n\ttop_p FLOAT, \n\tmax_tokens INTEGER NOT NULL, \n\treasoning_effort VARCHAR NOT NULL, \n\tthink BOOLEAN NOT NULL, \n\tposition INTEGER NOT NULL, \n\tbuilt_in BOOLEAN NOT NULL, \n\tPRIMARY KEY (id)\n)",
    "indexes": [],
    "columns": {
      "id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "name": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "provider_id": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "model": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "temperature": {
        "kind": "float"
      },
      "top_p": {
        "kind": "float"
      },
      "max_tokens": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "reasoning_effort": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "think": {
        "kind": "bool",
        "notNull": true,
        "default": false
      },
      "position": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": false
      }
    }
  },
  {
    "name": "preset_switches",
    "ddl": "CREATE TABLE preset_switches (\n\tpreset_id VARCHAR NOT NULL, \n\tflag_name VARCHAR NOT NULL, \n\tflag_value TEXT NOT NULL, \n\tbuilt_in BOOLEAN NOT NULL, \n\tPRIMARY KEY (preset_id, flag_name), \n\tFOREIGN KEY(preset_id) REFERENCES switch_presets (id) ON DELETE CASCADE\n)",
    "indexes": [],
    "columns": {
      "preset_id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "flag_name": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "flag_value": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": false
      }
    }
  },
  {
    "name": "knob_option",
    "ddl": "CREATE TABLE knob_option (\n\tflag_name VARCHAR NOT NULL, \n\tvalue VARCHAR NOT NULL, \n\tlabel VARCHAR NOT NULL, \n\tposition INTEGER NOT NULL, \n\tbuilt_in BOOLEAN NOT NULL, \n\tPRIMARY KEY (flag_name, value), \n\tFOREIGN KEY(flag_name) REFERENCES knob_catalog (flag_name) ON DELETE CASCADE\n)",
    "indexes": [],
    "columns": {
      "flag_name": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "value": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "label": {
        "kind": "text",
        "notNull": true,
        "default": ""
      },
      "position": {
        "kind": "int",
        "notNull": true,
        "default": 0
      },
      "built_in": {
        "kind": "bool",
        "notNull": true,
        "default": false
      }
    }
  },
  {
    "name": "engine_preset_samplers",
    "ddl": "CREATE TABLE engine_preset_samplers (\n\tpreset_id VARCHAR NOT NULL, \n\tparam_name VARCHAR NOT NULL, \n\tvalue TEXT NOT NULL, \n\tPRIMARY KEY (preset_id, param_name), \n\tFOREIGN KEY(preset_id) REFERENCES engine_presets (id) ON DELETE CASCADE\n)",
    "indexes": [],
    "columns": {
      "preset_id": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "param_name": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "value": {
        "kind": "text",
        "notNull": true,
        "default": ""
      }
    }
  },
  {
    "name": "feature_preset_refs",
    "ddl": "CREATE TABLE feature_preset_refs (\n\t\"key\" VARCHAR NOT NULL, \n\tpreset_id VARCHAR NOT NULL, \n\tPRIMARY KEY (\"key\"), \n\tFOREIGN KEY(preset_id) REFERENCES engine_presets (id) ON DELETE CASCADE\n)",
    "indexes": [],
    "columns": {
      "key": {
        "kind": "text",
        "pk": true,
        "notNull": true
      },
      "preset_id": {
        "kind": "text",
        "notNull": true
      }
    }
  }
];

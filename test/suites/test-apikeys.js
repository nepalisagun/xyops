const assert = require('node:assert/strict');
const Tools = require('pixl-tools');

exports.tests = [

    async function test_api_get_api_keys(test) {
        // list all API keys
        let { data } = await this.request.json( this.api_url + '/app/get_api_keys/v1', {} );
        assert.ok( data.code === 0, 'successful api response' );
        assert.ok( Array.isArray(data.rows), 'expected rows array' );
        assert.ok( data.list && (data.list.length >= 0), 'expected list metadata' );
    },

    async function test_api_get_api_key_missing_param(test) {
        // missing id param
        let { data } = await this.request.json( this.api_url + '/app/get_api_key/v1', {} );
        assert.ok( !!data.code, 'expected error for missing id' );
    },

    async function test_api_get_api_key_missing(test) {
        // non-existent key
        let { data } = await this.request.json( this.api_url + '/app/get_api_key/v1', { id: 'nope' } );
        assert.ok( !!data.code, 'expected error for missing api key' );
    },

    async function test_api_create_api_key(test) {
        // create a new API key
        let { data } = await this.request.json( this.api_url + '/app/create_api_key/v1', {
            title: 'Unit Test API Key',
            description: 'Created by unit tests',
            active: 1,
            privileges: {}
        });
        assert.ok( data.code === 0, 'successful api response' );
        assert.ok( data.api_key && data.api_key.id, 'expected api_key in response' );
        assert.ok( typeof data.plain_key === 'string' && data.plain_key.length >= 16, 'expected plain_key string' );
        this.api_key_id = data.api_key.id;
        this.api_plain_key = data.plain_key;
    },

    async function test_api_get_new_api_key(test) {
        // fetch our new key and validate fields
        let { data } = await this.request.json( this.api_url + '/app/get_api_key/v1', { id: this.api_key_id } );
        assert.ok( data.code === 0, 'successful api response' );
        assert.ok( data.api_key && data.api_key.id === this.api_key_id, 'api key id unexpected' );
        // key should be a sha256 hex digest (64 chars), not the plain key
        assert.ok( typeof data.api_key.key === 'string' && data.api_key.key.length === 64, 'unexpected key hash length' );
        assert.ok( data.api_key.key !== this.api_plain_key, 'stored key should be hashed, not plain' );
        // mask should expose first/last 4 chars
        let mask = this.api_plain_key.substring(0,4) + ('*').repeat(8) + this.api_plain_key.substring(this.api_plain_key.length - 4);
        assert.ok( data.api_key.mask === mask, 'unexpected api key mask' );
        this.api_key_hash = data.api_key.key;
    },

	async function test_api_key_auth_transports(test) {
		// Exercise real HTTP requests so query and body credentials remain distinct.
		// Temporarily change only the in-memory config, restoring even an absent key.
		var config = this.xy.config.get();
		var had_legacy = Object.prototype.hasOwnProperty.call(config, 'legacy_api_key_support');
		var saved_legacy = config.legacy_api_key_support;
		var url = this.api_url + '/app/get_tags/v1';
		var query_url = url + '?api_key=' + encodeURIComponent(this.api_plain_key);
		
		try {
			for (var legacy of [undefined, false, true]) {
				if (legacy === undefined) delete config.legacy_api_key_support;
				else config.legacy_api_key_support = legacy;
				var label = (legacy === undefined) ? 'unset' : String(legacy);
				
				// Clear the shared user's session header and cookies on every request.
				// A valid API key on the URL should work only with explicit legacy support,
				// regardless of whether the request uses GET or POST.
				for (var body of [false, {}]) {
					var method = (body === false) ? 'GET' : 'POST';
					let { data } = await this.request.json( query_url, body, {
						headers: { 'X-Session-ID': '', Cookie: '' }
					} );
					
					assert.equal( data.code, legacy ? 0 : 'session', label + ': ' + method + ' query auth result' );
					if (legacy) assert.ok( Array.isArray(data.rows), label + ': ' + method + ' authenticated response' );
					else assert.equal( data.description, 'No Session ID or API Key could be found', label + ': ' + method + ' ignores URL key' );
				}
				
				// Headers and JSON bodies work in every mode.  An invalid URL key must
				// neither interfere with these credentials nor override their precedence.
				let header_result = await this.request.json( url + '?api_key=invalid-url-key', false, {
					headers: { 'X-Session-ID': '', Cookie: '', 'X-API-Key': this.api_plain_key }
				} );
				assert.equal( header_result.data.code, 0, label + ': header auth succeeds despite URL key' );
				assert.ok( Array.isArray(header_result.data.rows), label + ': header authenticated response' );
				
				let body_result = await this.request.json( url + '?api_key=invalid-url-key', {
					api_key: this.api_plain_key
				}, {
					headers: { 'X-Session-ID': '', Cookie: '' }
				} );
				assert.equal( body_result.data.code, 0, label + ': JSON body auth succeeds despite URL key' );
				assert.ok( Array.isArray(body_result.data.rows), label + ': body authenticated response' );
				
				// Enabling the compatibility switch must still validate the URL key.
				let invalid_result = await this.request.json( url + '?api_key=invalid-url-key', false, {
					headers: { 'X-Session-ID': '', Cookie: '' }
				} );
				assert.equal( invalid_result.data.code, 'session', label + ': invalid URL key rejected' );
				assert.equal( invalid_result.data.description, legacy ? 'Invalid API Key' : 'No Session ID or API Key could be found', label + ': invalid URL key auth error' );
			}
		}
		finally {
			if (had_legacy) config.legacy_api_key_support = saved_legacy;
			else delete config.legacy_api_key_support;
		}
	},
	
    async function test_api_call_without_privilege_should_fail_access(test) {
        // using API key with no delete_tags privilege should yield access error
        let { data } = await this.request.json( this.api_url + '/app/delete_tag/v1', { id: 'not_found' }, {
            headers: {
                'X-Session-ID': '',
                'X-API-Key': this.api_plain_key
            }
        } );
        assert.ok( data.code === 'access', 'expected access error without privilege' );
        assert.ok( /Delete Tags/.test(data.description || ''), 'expected privilege name in error' );
    },

    async function test_api_update_api_key_add_privilege(test) {
        // grant delete_tags directly
        let { data } = await this.request.json( this.api_url + '/app/update_api_key/v1', {
            id: this.api_key_id,
            privileges: { delete_tags: 1 }
        });
        assert.ok( data.code === 0, 'successful api response' );
    },

    async function test_api_call_with_direct_privilege_should_hit_tag_not_found(test) {
        // now API key has delete_tags; should get tag error (not access)
        let { data } = await this.request.json( this.api_url + '/app/delete_tag/v1', { id: 'not_found' }, {
            headers: {
                'X-Session-ID': '',
                'X-API-Key': this.api_plain_key
            }
        } );
        assert.ok( data.code === 'tag', 'expected tag error when privilege is present' );
    },

    async function test_api_update_api_key_cannot_change_key_value(test) {
        // try to change the stored key hash (should be ignored)
        let before = await this.request.json( this.api_url + '/app/get_api_key/v1', { id: this.api_key_id } );
        let old_hash = before.data.api_key.key;
        let { data } = await this.request.json( this.api_url + '/app/update_api_key/v1', {
            id: this.api_key_id,
            key: 'should_not_change',
            title: 'UT API Key v2'
        });
        assert.ok( data.code === 0, 'successful api response' );
        let after = await this.request.json( this.api_url + '/app/get_api_key/v1', { id: this.api_key_id } );
        assert.ok( after.data.api_key.key === old_hash, 'api key hash should remain unchanged' );
    },

    async function test_api_create_tag_role_for_inherited_privs(test) {
        // create a role granting tag privileges
        let { data } = await this.request.json( this.api_url + '/app/create_role/v1', {
            title: 'Unit Test Tag Role',
            enabled: true,
            icon: '',
            notes: 'Created by unit tests',
            categories: [],
            groups: [],
            privileges: { create_tags: 1, edit_tags: 1, delete_tags: 1 }
        });
        assert.ok( data.code === 0, 'successful api response' );
        assert.ok( data.role && data.role.id, 'expected role id' );
        this.tag_role_id = data.role.id;
    },

    async function test_api_update_api_key_assign_role(test) {
        // remove direct privs and assign role that inherits delete_tags
        let { data } = await this.request.json( this.api_url + '/app/update_api_key/v1', {
            id: this.api_key_id,
            privileges: {},
            roles: [ this.tag_role_id ]
        });
        assert.ok( data.code === 0, 'successful api response' );
    },

    async function test_api_call_with_role_privilege_should_hit_tag_not_found(test) {
        // now API key should inherit delete_tags via role
        let { data } = await this.request.json( this.api_url + '/app/delete_tag/v1', { id: 'not_found' }, {
            headers: {
                'X-Session-ID': '',
                'X-API-Key': this.api_plain_key
            }
        } );
        assert.ok( data.code === 'tag', 'expected tag error when role privilege is present' );
    },

    async function test_api_remove_role_and_confirm_access_denied(test) {
        // remove role and ensure access denied again
        let { data } = await this.request.json( this.api_url + '/app/update_api_key/v1', {
            id: this.api_key_id,
            privileges: {},
            roles: []
        });
        assert.ok( data.code === 0, 'successful api response' );

        let res = await this.request.json( this.api_url + '/app/delete_tag/v1', { id: 'not_found' }, {
            headers: {
                'X-Session-ID': '',
                'X-API-Key': this.api_plain_key
            }
        } );
        assert.ok( res.data.code === 'access', 'expected access error without privilege again' );
    },

    async function test_api_get_api_keys_includes_new(test) {
        // list should include our newly created key
        let { data } = await this.request.json( this.api_url + '/app/get_api_keys/v1', {} );
        assert.ok( data.code === 0, 'successful api response' );
        let item = Tools.findObject( data.rows, { id: this.api_key_id } );
        assert.ok( !!item, 'expected to find our api key in list' );
        assert.ok( typeof item.mask === 'string', 'expected mask in list item' );
    },

    async function test_api_key_unexpired_allows_access(test) {
        // set future expiration and grant delete_tags, should allow API call
        let now = Tools.timeNow(true);
        let { data } = await this.request.json( this.api_url + '/app/update_api_key/v1', {
            id: this.api_key_id,
            privileges: { delete_tags: 1 },
            expires: now + 3600
        });
        assert.ok( data.code === 0, 'successful api response' );

        let res = await this.request.json( this.api_url + '/app/delete_tag/v1', { id: 'not_found' }, {
            headers: {
                'X-Session-ID': '',
                'X-API-Key': this.api_plain_key
            }
        } );
        assert.ok( res.data.code === 'tag', 'expected tag error when unexpired with privilege' );
    },

    async function test_api_key_expired_denies_access(test) {
        // set past expiration, API key should be rejected at auth
        let now = Tools.timeNow(true);
        let { data } = await this.request.json( this.api_url + '/app/update_api_key/v1', {
            id: this.api_key_id,
            privileges: { delete_tags: 1 },
            expires: now - 1
        });
        assert.ok( data.code === 0, 'successful api response' );

        let res = await this.request.json( this.api_url + '/app/delete_tag/v1', { id: 'not_found' }, {
            headers: {
                'X-Session-ID': '',
                'X-API-Key': this.api_plain_key
            }
        } );
        assert.ok( !!res.data.code, 'expected error for expired api key' );
        assert.ok( res.data.code === 'session', 'expected session error for expired api key' );
        assert.ok( /Invalid API Key|expired/i.test(res.data.description || ''), 'expected invalid/expired message' );
    },

    async function test_api_key_disabled_denies_access(test) {
        // set active to 0; key should be unusable immediately
        let now = Tools.timeNow(true);
        let { data } = await this.request.json( this.api_url + '/app/update_api_key/v1', {
            id: this.api_key_id,
            active: 0,
            privileges: { delete_tags: 1 },
            expires: now + 3600
        });
        assert.ok( data.code === 0, 'successful api response' );

        let res = await this.request.json( this.api_url + '/app/delete_tag/v1', { id: 'not_found' }, {
            headers: {
                'X-Session-ID': '',
                'X-API-Key': this.api_plain_key
            }
        } );
        assert.ok( !!res.data.code, 'expected error for disabled api key' );
        assert.ok( res.data.code === 'session', 'expected session error for disabled api key' );
        assert.ok( /Invalid API Key|disabled/i.test(res.data.description || ''), 'expected invalid/disabled message' );
    },

    async function test_api_key_reactivate_allows_access(test) {
        // set active back to 1 and ensure access is restored
        let now = Tools.timeNow(true);
        let { data } = await this.request.json( this.api_url + '/app/update_api_key/v1', {
            id: this.api_key_id,
            active: 1,
            privileges: { delete_tags: 1 },
            expires: now + 3600
        });
        assert.ok( data.code === 0, 'successful api response' );

        let res = await this.request.json( this.api_url + '/app/delete_tag/v1', { id: 'not_found' }, {
            headers: {
                'X-Session-ID': '',
                'X-API-Key': this.api_plain_key
            }
        } );
        assert.ok( res.data.code === 'tag', 'expected tag error when reactivated with privilege' );
    },

    async function test_api_update_api_key_missing_id(test) {
        // update without id should error
        let { data } = await this.request.json( this.api_url + '/app/update_api_key/v1', { title: 'oops' } );
        assert.ok( !!data.code, 'expected error for missing id' );
    },

    async function test_api_delete_api_key_missing_id(test) {
        // delete without id should error
        let { data } = await this.request.json( this.api_url + '/app/delete_api_key/v1', {} );
        assert.ok( !!data.code, 'expected error for missing id' );
    },

    async function test_api_delete_api_key_nonexistent(test) {
        // delete non-existent api key should error
        let { data } = await this.request.json( this.api_url + '/app/delete_api_key/v1', { id: 'nope' } );
        assert.ok( !!data.code, 'expected error for missing api key' );
    },

    async function test_api_delete_api_key(test) {
        // delete our key
        let { data } = await this.request.json( this.api_url + '/app/delete_api_key/v1', { id: this.api_key_id } );
        assert.ok( data.code === 0, 'successful api response' );
    },

    async function test_api_get_api_key_deleted(test) {
        // ensure deleted
        let { data } = await this.request.json( this.api_url + '/app/get_api_key/v1', { id: this.api_key_id } );
        assert.ok( !!data.code, 'expected error for missing api key' );
        delete this.api_key_id;
        delete this.api_plain_key;
    },

    async function test_api_delete_role_cleanup(test) {
        // cleanup: delete our role
        let { data } = await this.request.json( this.api_url + '/app/delete_role/v1', { id: this.tag_role_id } );
        assert.ok( data.code === 0, 'successful api response' );
        delete this.tag_role_id;
    }

];
